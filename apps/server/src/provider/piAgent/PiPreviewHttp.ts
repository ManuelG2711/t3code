import {
  PreviewAutomationClickInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationPressInput,
  PreviewAutomationScrollInput,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
  type PreviewAutomationError,
  type PreviewAutomationOperation,
  type PreviewAutomationSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import type * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";
import { PI_PREVIEW_BRIDGE_ROUTE_PREFIX } from "./PiPreviewBridge.ts";

type BridgeResponse =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false;
      readonly error: {
        readonly tag: string;
        readonly message: string;
        readonly detail?: unknown;
      };
    };

interface BridgeHttpResult {
  readonly status: number;
  readonly body: BridgeResponse;
}

interface ExecutePiPreviewBridgeOperationInput {
  readonly operation: PreviewAutomationOperation | undefined;
  readonly authorizationHeader: string | undefined;
  readonly body: unknown;
  readonly resolveScope: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  readonly invoke: (
    request: PreviewAutomationBroker.PreviewAutomationInvokeInput,
  ) => Effect.Effect<unknown, PreviewAutomationError>;
}

const operations = new Set<PreviewAutomationOperation>([
  "status",
  "open",
  "navigate",
  "snapshot",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "waitFor",
  "recordingStart",
  "recordingStop",
]);

const decodePreviewOpenInput = Schema.decodeUnknownEffect(PreviewAutomationOpenInput);
const decodePreviewNavigateInput = Schema.decodeUnknownEffect(PreviewAutomationNavigateInput);
const decodePreviewClickInput = Schema.decodeUnknownEffect(PreviewAutomationClickInput);
const decodePreviewTypeInput = Schema.decodeUnknownEffect(PreviewAutomationTypeInput);
const decodePreviewPressInput = Schema.decodeUnknownEffect(PreviewAutomationPressInput);
const decodePreviewScrollInput = Schema.decodeUnknownEffect(PreviewAutomationScrollInput);
const decodePreviewEvaluateInput = Schema.decodeUnknownEffect(PreviewAutomationEvaluateInput);
const decodePreviewWaitForInput = Schema.decodeUnknownEffect(PreviewAutomationWaitForInput);

function responseJson(result: BridgeHttpResult) {
  return HttpServerResponse.jsonUnsafe(result.body, {
    status: result.status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function success(result: unknown): BridgeHttpResult {
  return { status: 200, body: { ok: true, result } };
}

function failure(status: number, tag: string, message: string, detail?: unknown): BridgeHttpResult {
  return {
    status,
    body: {
      ok: false,
      error: {
        tag,
        message,
        ...(detail === undefined ? {} : { detail }),
      },
    },
  };
}

function bearerTokenFromHeader(value: string | undefined): string {
  return value?.startsWith("Bearer ") === true ? value.slice("Bearer ".length).trim() : "";
}

function operationFromRequest(request: HttpServerRequest.HttpServerRequest) {
  const url = HttpServerRequest.toURL(request);
  if (url._tag === "None") return undefined;
  const prefix = `${PI_PREVIEW_BRIDGE_ROUTE_PREFIX}/`;
  if (!url.value.pathname.startsWith(prefix)) return undefined;
  const rawOperation = decodeURIComponent(url.value.pathname.slice(prefix.length));
  return operations.has(rawOperation as PreviewAutomationOperation)
    ? (rawOperation as PreviewAutomationOperation)
    : undefined;
}

function serializePreviewError(error: PreviewAutomationError) {
  const record = error as unknown as {
    readonly _tag?: string;
    readonly message?: string;
    readonly detail?: unknown;
  };
  return {
    tag: record._tag ?? error.constructor.name ?? "PreviewAutomationExecutionError",
    message: record.message ?? String(error),
    ...(record.detail === undefined ? {} : { detail: record.detail }),
  };
}

function timeoutFromInput(input: unknown): number | undefined {
  return typeof input === "object" &&
    input !== null &&
    "timeoutMs" in input &&
    typeof input.timeoutMs === "number"
    ? input.timeoutMs
    : undefined;
}

function summarizeSnapshot(snapshot: PreviewAutomationSnapshot) {
  const { screenshot, ...page } = snapshot;
  return {
    ...page,
    screenshot: {
      mimeType: screenshot.mimeType,
      width: screenshot.width,
      height: screenshot.height,
    },
  };
}

function normalizeResult(operation: PreviewAutomationOperation, result: unknown): unknown {
  if (
    operation === "snapshot" &&
    typeof result === "object" &&
    result !== null &&
    "screenshot" in result
  ) {
    return summarizeSnapshot(result as PreviewAutomationSnapshot);
  }
  return result ?? null;
}

function decodeInput(
  operation: PreviewAutomationOperation,
  rawInput: unknown,
): Effect.Effect<unknown, Schema.SchemaError> {
  switch (operation) {
    case "open":
      return decodePreviewOpenInput(rawInput);
    case "navigate":
      return decodePreviewNavigateInput(rawInput);
    case "click":
      return decodePreviewClickInput(rawInput);
    case "type":
      return decodePreviewTypeInput(rawInput);
    case "press":
      return decodePreviewPressInput(rawInput);
    case "scroll":
      return decodePreviewScrollInput(rawInput);
    case "evaluate":
      return decodePreviewEvaluateInput(rawInput);
    case "waitFor":
      return decodePreviewWaitForInput(rawInput);
    case "recordingStart":
    case "recordingStop":
    case "snapshot":
    case "status":
      return Effect.succeed({});
  }
}

export const executePiPreviewBridgeOperation = (
  input: ExecutePiPreviewBridgeOperationInput,
): Effect.Effect<BridgeHttpResult> =>
  Effect.gen(function* () {
    if (!input.operation) {
      return failure(
        404,
        "PiPreviewBridgeUnknownOperation",
        "Unknown T3 Code Pi preview bridge operation.",
      );
    }

    const token = bearerTokenFromHeader(input.authorizationHeader);
    const scope = yield* input.resolveScope(token);
    if (!scope) {
      return failure(
        401,
        "PiPreviewBridgeUnauthorized",
        "A valid provider-scoped preview bearer credential is required.",
      );
    }
    if (!scope.capabilities.has("preview")) {
      return failure(
        403,
        "PiPreviewBridgeForbidden",
        "The provider-scoped credential does not grant preview automation.",
      );
    }

    const decodedInput = yield* decodeInput(input.operation, input.body).pipe(
      Effect.mapError((error) => ({
        tag: "PiPreviewBridgeInvalidInput",
        message: SchemaIssue.makeFormatterDefault()(error.issue),
      })),
      Effect.result,
    );
    if (Result.isFailure(decodedInput)) {
      return failure(400, decodedInput.failure.tag, decodedInput.failure.message);
    }

    const timeoutMs = timeoutFromInput(decodedInput.success);
    const result = yield* input
      .invoke({
        scope,
        operation: input.operation,
        input: decodedInput.success,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })
      .pipe(Effect.result);

    if (Result.isFailure(result)) {
      const error = serializePreviewError(result.failure);
      return failure(502, error.tag, error.message, error.detail);
    }

    return success(normalizeResult(input.operation, result.success));
  });

export const piPreviewBridgeRouteLayer = HttpRouter.add(
  "POST",
  `${PI_PREVIEW_BRIDGE_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const operation = operationFromRequest(request);
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => ({}) as unknown));
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const result = yield* executePiPreviewBridgeOperation({
      operation,
      authorizationHeader: request.headers.authorization,
      body,
      resolveScope: McpSessionRegistry.resolveActiveMcpCredential,
      invoke: (invokeInput) => broker.invoke(invokeInput),
    });
    return responseJson(result);
  }),
);

export const __testing = {
  bearerTokenFromHeader,
  normalizeResult,
  operationFromRequest,
  serializePreviewError,
  summarizeSnapshot,
};
