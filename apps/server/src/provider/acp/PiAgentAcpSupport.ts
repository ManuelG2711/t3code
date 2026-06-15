import {
  type PiAgentSettings,
  ProviderDriverKind,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

const PI_AGENT_DRIVER_KIND = ProviderDriverKind.make("piAgent");
export const PI_AGENT_DEFAULT_MODEL = "default";
export const PI_AGENT_MODE_OPTION_ID = "piAgentMode";

type PiAgentAcpRuntimeSettings = Pick<PiAgentSettings, "binaryPath" | "launchArgs">;

export interface PiAgentAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly piAgentSettings: PiAgentAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function splitPiAgentLaunchArgs(value: string | null | undefined): ReadonlyArray<string> {
  const input = value?.trim();
  if (!input) return [];

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (current.length > 0) tokens.push(current);
  return tokens;
}

export function buildPiAgentAcpSpawnInput(
  piAgentSettings: PiAgentAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSpawnInput {
  return {
    command: piAgentSettings?.binaryPath || "pi-acp",
    args: splitPiAgentLaunchArgs(piAgentSettings?.launchArgs),
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export function resolvePiAgentAuthMethodId(
  initializeResult: EffectAcpSchema.InitializeResponse,
): string {
  const authMethods = initializeResult.authMethods ?? [];
  const terminal = authMethods.find((method) => "type" in method && method.type === "terminal");
  return terminal?.id ?? authMethods[0]?.id ?? "terminal";
}

export const makePiAgentAcpRuntime = (
  input: PiAgentAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildPiAgentAcpSpawnInput(input.piAgentSettings, input.cwd, input.environment),
        authMethodId: resolvePiAgentAuthMethodId,
        clientCapabilities: {
          auth: { terminal: true },
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });

export function resolvePiAgentBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === PI_AGENT_DEFAULT_MODEL) {
    return PI_AGENT_DEFAULT_MODEL;
  }
  return normalizeModelSlug(trimmed, PI_AGENT_DRIVER_KIND) ?? trimmed;
}

export function currentPiAgentModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

function isMethodNotFound(cause: EffectAcpErrors.AcpError): boolean {
  return cause._tag === "AcpRequestError" && cause.code === -32601;
}

function selectConfigOptionValues(
  option: EffectAcpSchema.SessionConfigOption,
): ReadonlyArray<string> {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) =>
    "value" in entry ? [entry.value] : entry.options.map((nested) => nested.value),
  );
}

function findModelConfigOptionForValue(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  value: string,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions.find(
    (option) =>
      option.category === "model" &&
      option.type === "select" &&
      selectConfigOptionValues(option).includes(value),
  );
}

function findThoughtLevelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  selection: ProviderOptionSelection,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions.find(
    (option) => option.category === "thought_level" && option.id.trim() === selection.id.trim(),
  );
}

export function applyPiAgentAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntimeShape,
    "getConfigOptions" | "getModeState" | "setConfigOption" | "setSessionMode" | "setSessionModel"
  >;
  readonly model: string | null | undefined;
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const requested = resolvePiAgentBaseModelId(input.model);
  return Effect.gen(function* () {
    const configOptions = yield* input.runtime.getConfigOptions;
    if (requested !== PI_AGENT_DEFAULT_MODEL) {
      const modelConfigOption = findModelConfigOptionForValue(configOptions, requested);
      if (modelConfigOption) {
        yield* input.runtime
          .setConfigOption(modelConfigOption.id, requested)
          .pipe(
            Effect.catch((cause) =>
              isMethodNotFound(cause)
                ? input.runtime.setSessionModel(requested).pipe(Effect.asVoid)
                : Effect.fail(cause),
            ),
          );
      } else {
        yield* input.runtime.setSessionModel(requested).pipe(Effect.asVoid);
      }
    }

    for (const selection of input.selections ?? []) {
      const thoughtLevelOption = findThoughtLevelConfigOption(configOptions, selection);
      if (thoughtLevelOption) {
        yield* input.runtime.setConfigOption(thoughtLevelOption.id, selection.value);
        continue;
      }
      if (selection.id === PI_AGENT_MODE_OPTION_ID && typeof selection.value === "string") {
        yield* input.runtime.setSessionMode(selection.value);
      }
    }

    return requested;
  }).pipe(Effect.mapError(input.mapError));
}
