import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ProviderOptionSelection,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type UserInputQuestion,
  ProviderInstanceId,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type * as EffectAcpSchema from "effect-acp/schema";
import * as EffectAcpErrors from "effect-acp/errors";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "./AcpAdapterSupport.ts";
import type { AcpSessionRuntimeShape } from "./AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "./AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "./AcpRuntimeModel.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);

export interface GenericAcpProviderAdapterOptions {
  readonly provider: ProviderDriverKind;
  readonly providerLabel: string;
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly defaultModel: string;
  readonly makeRuntime: (input: {
    readonly cwd: string;
    readonly resumeSessionId?: string | undefined;
    readonly runtimeMode: RuntimeMode;
    readonly mcpServers?: ReadonlyArray<EffectAcpSchema.McpServer> | undefined;
  }) => Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope>;
  readonly applyModelSelection?: (input: {
    readonly runtime: AcpSessionRuntimeShape;
    readonly model: string | undefined;
    readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  }) => Effect.Effect<string | undefined, EffectAcpErrors.AcpError>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers | undefined>;
}

interface GenericAcpSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  promptsInFlight: number;
  stopped: boolean;
}

const GENERIC_ACP_RESUME_VERSION = 1 as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== GENERIC_ACP_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  return request.options.find((entry) => entry.kind === kind)?.optionId.trim() || undefined;
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "acceptForSession") ??
    selectPermissionOptionId(request, "accept")
  );
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsCancelled(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.answers, undefined).pipe(Effect.ignore),
    { discard: true },
  );
}

function optionLabelsFromStringSchema(
  property: Extract<EffectAcpSchema.ElicitationPropertySchema, { readonly type: "string" }>,
): ReadonlyArray<{ readonly label: string; readonly description: string }> {
  if (property.oneOf && property.oneOf.length > 0) {
    return property.oneOf.map((option) => ({
      label: option.title,
      description: option.const,
    }));
  }
  return (property.enum ?? []).map((value) => ({ label: value, description: value }));
}

function optionLabelsFromArraySchema(
  property: Extract<EffectAcpSchema.ElicitationPropertySchema, { readonly type: "array" }>,
): ReadonlyArray<{ readonly label: string; readonly description: string }> {
  if ("anyOf" in property.items) {
    return property.items.anyOf.map((option) => ({
      label: option.title,
      description: option.const,
    }));
  }
  return property.items.enum.map((value) => ({ label: value, description: value }));
}

function stringArrayFromUnknown(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => (typeof entry === "string" ? [entry] : []))
    : [];
}

function extensionUiSelectQuestionsFromPermission(
  request: EffectAcpSchema.RequestPermissionRequest,
): UserInputQuestion[] | undefined {
  const rawInput = request.toolCall.rawInput;
  if (!isRecord(rawInput) || rawInput.method !== "select") return undefined;
  const options = stringArrayFromUnknown(rawInput.options);
  if (options.length === 0) return undefined;
  const title =
    typeof rawInput.title === "string" && rawInput.title.trim() ? rawInput.title : undefined;
  const message =
    typeof rawInput.message === "string" && rawInput.message.trim() ? rawInput.message : undefined;
  return [
    {
      id: "choice",
      header: title ?? "Input required",
      question: message ?? title ?? request.toolCall.title ?? "Choose an option",
      options: options.map((label, index) => ({
        label,
        description: request.options[index]?.optionId ?? label,
      })),
    },
  ];
}

function selectedExtensionUiOptionIdFromAnswers(
  request: EffectAcpSchema.RequestPermissionRequest,
  answers: ProviderUserInputAnswers | undefined,
): string | undefined {
  if (!answers) return undefined;
  const rawInput = request.toolCall.rawInput;
  if (!isRecord(rawInput)) return undefined;
  const options = stringArrayFromUnknown(rawInput.options);
  const selected = firstAnswerValue(answers.choice);
  if (typeof selected !== "string") return undefined;
  const index = options.findIndex((option) => option === selected);
  if (index >= 0) return request.options[index]?.optionId;
  return request.options.find((option) => option.optionId === selected)?.optionId;
}

function questionsFromElicitation(
  request: EffectAcpSchema.ElicitationRequest,
): UserInputQuestion[] {
  if (request.mode === "url") {
    return [
      {
        id: "url",
        header: "Input required",
        question: `${request.message}\n${request.url}`,
        options: [{ label: "Done", description: "Continue after completing the external flow" }],
      },
    ];
  }

  const schema = request.requestedSchema;
  const entries = Object.entries(schema.properties ?? {});
  if (entries.length === 0) {
    return [
      {
        id: "response",
        header: schema.title ?? "Input required",
        question: schema.description ?? request.message,
        options: [],
      },
    ];
  }

  return entries.map(([id, property]) => {
    const header = schema.title ?? "Input required";
    const question = property.title ?? property.description ?? request.message;
    switch (property.type) {
      case "string":
        return {
          id,
          header,
          question,
          options: optionLabelsFromStringSchema(property),
        };
      case "array":
        return {
          id,
          header,
          question,
          multiSelect: true,
          options: optionLabelsFromArraySchema(property),
        };
      case "boolean":
        return {
          id,
          header,
          question,
          options: [
            { label: "Yes", description: "true" },
            { label: "No", description: "false" },
          ],
        };
      default:
        return {
          id,
          header,
          question,
          options: [],
        };
    }
  });
}

function firstAnswerValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function mapStringAnswer(
  property: Extract<EffectAcpSchema.ElicitationPropertySchema, { readonly type: "string" }>,
  value: unknown,
): string | undefined {
  const rawAnswer = firstAnswerValue(value);
  if (typeof rawAnswer !== "string" || rawAnswer.trim().length === 0) return undefined;
  const trimmed = rawAnswer.trim();
  const titled = property.oneOf?.find(
    (option) => option.title === trimmed || option.const === trimmed,
  );
  return titled?.const ?? trimmed;
}

function mapArrayAnswer(
  property: Extract<EffectAcpSchema.ElicitationPropertySchema, { readonly type: "array" }>,
  value: unknown,
): ReadonlyArray<string> | undefined {
  const answers = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const normalized = answers.flatMap((entry) =>
    typeof entry === "string" && entry.trim().length > 0 ? [entry.trim()] : [],
  );
  const items = property.items;
  if ("anyOf" in items) {
    return normalized.map(
      (entry) =>
        items.anyOf.find((option) => option.title === entry || option.const === entry)?.const ??
        entry,
    );
  }
  return normalized;
}

function mapElicitationAnswer(
  property: EffectAcpSchema.ElicitationPropertySchema,
  value: unknown,
): EffectAcpSchema.ElicitationContentValue | undefined {
  switch (property.type) {
    case "string":
      return mapStringAnswer(property, value);
    case "array":
      return mapArrayAnswer(property, value);
    case "boolean": {
      const answer = firstAnswerValue(value);
      if (typeof answer === "boolean") return answer;
      if (typeof answer !== "string") return undefined;
      if (answer.toLowerCase() === "yes" || answer.toLowerCase() === "true") return true;
      if (answer.toLowerCase() === "no" || answer.toLowerCase() === "false") return false;
      return undefined;
    }
    case "integer": {
      const answer = firstAnswerValue(value);
      const numeric =
        typeof answer === "number" ? answer : typeof answer === "string" ? Number(answer) : NaN;
      return Number.isInteger(numeric) ? numeric : undefined;
    }
    case "number": {
      const answer = firstAnswerValue(value);
      const numeric =
        typeof answer === "number" ? answer : typeof answer === "string" ? Number(answer) : NaN;
      return Number.isFinite(numeric) ? numeric : undefined;
    }
  }
}

function isElicitationContentValue(
  value: unknown,
): value is EffectAcpSchema.ElicitationContentValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  );
}

function makeAnswerContent(
  answers: ProviderUserInputAnswers,
): Record<string, EffectAcpSchema.ElicitationContentValue> {
  return Object.fromEntries(
    Object.entries(answers).flatMap(([key, value]) =>
      isElicitationContentValue(value) ? ([[key, value]] as const) : [],
    ),
  );
}

function makeElicitationResponse(
  request: EffectAcpSchema.ElicitationRequest,
  answers: ProviderUserInputAnswers | undefined,
): EffectAcpSchema.ElicitationResponse {
  if (answers === undefined) {
    return { action: { action: "cancel" } };
  }
  if (request.mode === "url") {
    return { action: { action: "accept", content: makeAnswerContent(answers) } };
  }

  const properties = request.requestedSchema.properties ?? {};
  const content = Object.fromEntries(
    Object.entries(properties).flatMap(([id, property]) => {
      const mapped = mapElicitationAnswer(property, answers[id]);
      return mapped === undefined ? [] : ([[id, mapped]] as const);
    }),
  );
  return {
    action: {
      action: "accept",
      content: Object.keys(content).length > 0 ? content : makeAnswerContent(answers),
    },
  };
}

export const makeGenericAcpProviderAdapter = (options: GenericAcpProviderAdapterOptions) =>
  Effect.gen(function* () {
    const boundInstanceId = options.instanceId ?? ProviderInstanceId.make(options.provider);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options.nativeEventLogger ??
      (options.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, GenericAcpSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: options.provider,
            method: "crypto/randomUUIDv4",
            detail: `Failed to generate ${options.providerLabel} runtime identifier.`,
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: options.provider,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      }).pipe(Effect.ignore);

    const emitPlanUpdate = (
      ctx: GenericAcpSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) return;
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: options.provider,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source: "acp.jsonrpc",
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<GenericAcpSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: options.provider, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: GenericAcpSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: options.provider,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== options.provider) {
            return yield* new ProviderAdapterValidationError({
              provider: options.provider,
              operation: "startSession",
              issue: `Expected provider '${options.provider}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: options.provider,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const modelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const resumeSessionId = parseResume(input.resumeCursor)?.sessionId;
          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const acp = yield* options
            .makeRuntime({
              cwd,
              ...(resumeSessionId ? { resumeSessionId } : {}),
              runtimeMode: input.runtimeMode,
              ...(mcpSession
                ? {
                    mcpServers: [
                      {
                        type: "http" as const,
                        name: "t3-code",
                        url: mcpSession.endpoint,
                        headers: [
                          {
                            name: "Authorization",
                            value: mcpSession.authorizationHeader,
                          },
                        ],
                      },
                    ],
                  }
                : {}),
            })
            .pipe(
              Effect.provideService(Scope.Scope, sessionScope),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: options.provider,
                    threadId: input.threadId,
                    detail: cause.message,
                    cause,
                  }),
              ),
            );

          let ctx!: GenericAcpSessionContext;
          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/request_permission", params);
                const extensionUiQuestions = extensionUiSelectQuestionsFromPermission(params);
                if (extensionUiQuestions) {
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const answers = yield* Deferred.make<ProviderUserInputAnswers | undefined>();
                  pendingUserInputs.set(requestId, { answers });
                  yield* offerRuntimeEvent({
                    type: "user-input.requested",
                    ...(yield* makeEventStamp()),
                    provider: options.provider,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    payload: { questions: extensionUiQuestions },
                    raw: {
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      payload: params,
                    },
                  });
                  const resolved = yield* Deferred.await(answers);
                  pendingUserInputs.delete(requestId);
                  yield* offerRuntimeEvent({
                    type: "user-input.resolved",
                    ...(yield* makeEventStamp()),
                    provider: options.provider,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    payload: { answers: resolved ?? {} },
                  });
                  const selectedOptionId = selectedExtensionUiOptionIdFromAnswers(params, resolved);
                  return {
                    outcome: selectedOptionId
                      ? { outcome: "selected" as const, optionId: selectedOptionId }
                      : ({ outcome: "cancelled" } as const),
                  };
                }
                if (input.runtimeMode === "full-access") {
                  const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                  if (autoApprovedOptionId !== undefined) {
                    return {
                      outcome: {
                        outcome: "selected" as const,
                        optionId: autoApprovedOptionId,
                      },
                    };
                  }
                }
                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                pendingApprovals.set(requestId, { decision });
                yield* offerRuntimeEvent(
                  makeAcpRequestOpenedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: options.provider,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    detail:
                      permissionRequest.detail ??
                      encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                      "[unserializable params]",
                    args: params,
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: params,
                  }),
                );
                const resolved = yield* Deferred.await(decision);
                pendingApprovals.delete(requestId);
                yield* offerRuntimeEvent(
                  makeAcpRequestResolvedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: options.provider,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    decision: resolved,
                  }),
                );
                const selectedOptionId =
                  resolved === "cancel" ? undefined : selectPermissionOptionId(params, resolved);
                return {
                  outcome: selectedOptionId
                    ? { outcome: "selected" as const, optionId: selectedOptionId }
                    : ({ outcome: "cancelled" } as const),
                };
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new EffectAcpErrors.AcpTransportError({
                      detail: `Failed to process ${options.providerLabel} ACP permission callback.`,
                      cause,
                    }),
                ),
              ),
            );
            yield* acp.handleElicitation((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/elicitation", params);
                const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const answers = yield* Deferred.make<ProviderUserInputAnswers | undefined>();
                pendingUserInputs.set(requestId, { answers });
                yield* offerRuntimeEvent({
                  type: "user-input.requested",
                  ...(yield* makeEventStamp()),
                  provider: options.provider,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  payload: { questions: questionsFromElicitation(params) },
                  raw: {
                    source: "acp.jsonrpc",
                    method: "session/elicitation",
                    payload: params,
                  },
                });
                const resolved = yield* Deferred.await(answers);
                pendingUserInputs.delete(requestId);
                yield* offerRuntimeEvent({
                  type: "user-input.resolved",
                  ...(yield* makeEventStamp()),
                  provider: options.provider,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  payload: { answers: resolved ?? {} },
                });
                return makeElicitationResponse(params, resolved);
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new EffectAcpErrors.AcpTransportError({
                      detail: `Failed to process ${options.providerLabel} ACP elicitation callback.`,
                      cause,
                    }),
                ),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(options.provider, input.threadId, "session/start", error),
            ),
          );

          const appliedModel = yield* (
            options.applyModelSelection
              ? options.applyModelSelection({
                  runtime: acp,
                  model: modelSelection?.model,
                  selections: modelSelection?.options,
                })
              : Effect.succeed(modelSelection?.model)
          ).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(options.provider, input.threadId, "session/set_model", error),
            ),
          );

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: options.provider,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: appliedModel ?? modelSelection?.model ?? options.defaultModel,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: GENERIC_ACP_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            promptsInFlight: 0,
            stopped: false,
          };

          const notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: options.provider,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: options.provider,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* emitPlanUpdate(ctx, event.payload, event.rawPayload, "session/update");
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: options.provider,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: options.provider,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError(`Failed to process ${options.providerLabel} runtime notification.`, {
                cause,
              }),
            ),
            Effect.forkChild,
          );

          ctx.notificationFiber = notificationFiber;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: options.provider,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: options.provider,
            threadId: input.threadId,
            payload: { state: "ready", reason: `${options.providerLabel} ACP session ready` },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: options.provider,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const turnId = TurnId.make(yield* randomUUIDv4);
        ctx.promptsInFlight += 1;

        return yield* Effect.gen(function* () {
          const turnModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const appliedModel = yield* (
            options.applyModelSelection
              ? options.applyModelSelection({
                  runtime: ctx.acp,
                  model: turnModelSelection?.model,
                  selections: turnModelSelection?.options,
                })
              : Effect.succeed(turnModelSelection?.model)
          ).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(options.provider, input.threadId, "session/set_model", error),
            ),
          );

          const text = input.input?.trim();
          const imagePromptParts = yield* Effect.forEach(input.attachments ?? [], (attachment) =>
            Effect.gen(function* () {
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* new ProviderAdapterRequestError({
                  provider: options.provider,
                  method: "session/prompt",
                  detail: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: options.provider,
                      method: "session/prompt",
                      detail: cause.message,
                      cause,
                    }),
                ),
              );
              return {
                type: "image",
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              } satisfies EffectAcpSchema.ContentBlock;
            }),
          );
          const promptParts: Array<EffectAcpSchema.ContentBlock> = [
            ...(text ? [{ type: "text" as const, text }] : []),
            ...imagePromptParts,
          ];
          if (promptParts.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: options.provider,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }

          ctx.activeTurnId = turnId;
          ctx.lastPlanFingerprint = undefined;
          ctx.session = {
            ...ctx.session,
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
            model: appliedModel ?? turnModelSelection?.model ?? ctx.session.model,
          };
          yield* offerRuntimeEvent({
            type: "turn.started",
            ...(yield* makeEventStamp()),
            provider: options.provider,
            threadId: input.threadId,
            turnId,
            payload: { model: ctx.session.model },
          });

          const result = yield* ctx.acp
            .prompt({ prompt: promptParts })
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(options.provider, input.threadId, "session/prompt", error),
              ),
            );
          ctx.turns = [...ctx.turns, { id: turnId, items: [{ prompt: promptParts, result }] }];
          ctx.session = {
            ...ctx.session,
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
          };
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: options.provider,
            threadId: input.threadId,
            turnId,
            payload: {
              state: result.stopReason === "cancelled" ? "cancelled" : "completed",
              stopReason: result.stopReason ?? null,
            },
          });

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
            }),
          ),
        );
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(options.provider, threadId, "session/cancel", error),
            ),
          ),
        );
      });

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: options.provider,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: options.provider,
            method: "session/elicitation",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
      threadId,
      numTurns,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: options.provider,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        ctx.turns = ctx.turns.slice(0, Math.max(0, ctx.turns.length - numTurns));
        return { threadId, turns: ctx.turns };
      });

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions = () =>
      Effect.sync(() => Array.from(sessions.values(), (session) => ({ ...session.session })));

    const hasSession = (threadId: ThreadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const stopAll = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    return {
      provider: options.provider,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput: (
        threadId: ThreadId,
        requestId: ApprovalRequestId,
        answers: ProviderUserInputAnswers,
      ) => respondToUserInput(threadId, requestId, answers),
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
