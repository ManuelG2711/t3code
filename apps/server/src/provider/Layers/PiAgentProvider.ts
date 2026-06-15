import {
  type ModelCapabilities,
  type PiAgentSettings,
  type ProviderOptionChoice,
  type ProviderOptionDescriptor,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  makePiAgentAcpRuntime,
  PI_AGENT_DEFAULT_MODEL,
  PI_AGENT_MODE_OPTION_ID,
  splitPiAgentLaunchArgs,
} from "../acp/PiAgentAcpSupport.ts";
import { parseSessionModeState } from "../acp/AcpRuntimeModel.ts";

const PROVIDER = ProviderDriverKind.make("piAgent");
const PI_AGENT_PRESENTATION = {
  displayName: "Pi Agent",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const PI_AGENT_ACP_START_TIMEOUT_MS = 15_000;
const PI_AGENT_VERSION_TIMEOUT_MS = 4_000;
const PI_AGENT_PERMISSION_WARNING =
  "Pi/pi-acp runs with the permissions of the launched local process; T3 Code approval mode is not a sandbox for this provider.";

const buildPiAgentDefaultModel = (
  capabilities: ModelCapabilities = EMPTY_CAPABILITIES,
): ServerProviderModel => ({
  slug: PI_AGENT_DEFAULT_MODEL,
  name: "Pi default",
  isCustom: false,
  capabilities,
});

export function piAgentModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = [buildPiAgentDefaultModel()],
  customModelCapabilities: ModelCapabilities = EMPTY_CAPABILITIES,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    builtInModels,
    PROVIDER,
    customModels ?? [],
    customModelCapabilities,
  );
}

export function buildPiAgentModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
  capabilities: ModelCapabilities = EMPTY_CAPABILITIES,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [buildPiAgentDefaultModel(capabilities)];
  seen.add(PI_AGENT_DEFAULT_MODEL);
  for (const model of modelState.availableModels) {
    const slug = model.modelId.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: model.name.trim() || slug,
      isCustom: false,
      capabilities,
    });
  }
  return models;
}

function flattenConfigSelectChoices(
  option: Extract<EffectAcpSchema.SessionConfigOption, { readonly type: "select" }>,
): ReadonlyArray<ProviderOptionChoice> {
  return option.options.flatMap((entry) =>
    "value" in entry
      ? [
          {
            id: entry.value,
            label: entry.name.trim() || entry.value,
            ...(entry.description?.trim() ? { description: entry.description.trim() } : {}),
            ...(entry.value === option.currentValue ? { isDefault: true } : {}),
          },
        ]
      : entry.options.map((nested) => ({
          id: nested.value,
          label: nested.name.trim() || nested.value,
          ...(nested.description?.trim() ? { description: nested.description.trim() } : {}),
          ...(nested.value === option.currentValue ? { isDefault: true } : {}),
        })),
  );
}

function buildDescriptorFromThoughtLevelOption(
  option: EffectAcpSchema.SessionConfigOption | undefined,
): ProviderOptionDescriptor | undefined {
  if (!option || option.type !== "select") return undefined;
  const choices = flattenConfigSelectChoices(option);
  if (choices.length === 0) return undefined;
  return {
    id: option.id,
    type: "select",
    label: option.name.trim() || "Reasoning",
    ...(option.description?.trim() ? { description: option.description.trim() } : {}),
    options: choices,
    currentValue: option.currentValue,
  };
}

function buildDescriptorFromSessionModes(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): ProviderOptionDescriptor | undefined {
  const modeState = parseSessionModeState(sessionSetupResult);
  if (!modeState) return undefined;
  return {
    id: PI_AGENT_MODE_OPTION_ID,
    type: "select",
    label: "Reasoning",
    options: modeState.availableModes.map((mode) => ({
      id: mode.id,
      label: mode.name,
      ...(mode.description ? { description: mode.description } : {}),
      ...(mode.id === modeState.currentModeId ? { isDefault: true } : {}),
    })),
    currentValue: modeState.currentModeId,
  };
}

export function buildPiAgentCapabilitiesFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): ModelCapabilities {
  const thoughtLevelDescriptor = buildDescriptorFromThoughtLevelOption(
    sessionSetupResult.configOptions?.find((option) => option.category === "thought_level"),
  );
  const modeDescriptor = thoughtLevelDescriptor
    ? undefined
    : buildDescriptorFromSessionModes(sessionSetupResult);
  return createModelCapabilities({
    optionDescriptors: [thoughtLevelDescriptor ?? modeDescriptor].filter(
      (descriptor): descriptor is ProviderOptionDescriptor => descriptor !== undefined,
    ),
  });
}

export function buildPiAgentModelsFromSessionConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  capabilities: ModelCapabilities = EMPTY_CAPABILITIES,
): ReadonlyArray<ServerProviderModel> {
  const modelOption = configOptions?.find(
    (option): option is Extract<EffectAcpSchema.SessionConfigOption, { readonly type: "select" }> =>
      option.category === "model" && option.type === "select",
  );
  if (!modelOption) return [];
  const seen = new Set<string>([PI_AGENT_DEFAULT_MODEL]);
  const models: ServerProviderModel[] = [buildPiAgentDefaultModel(capabilities)];
  for (const choice of flattenConfigSelectChoices(modelOption)) {
    const slug = choice.id.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: choice.label,
      isCustom: false,
      capabilities,
    });
  }
  return models;
}

export function buildPiAgentDiscoveryFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly capabilities: ModelCapabilities;
} {
  const capabilities = buildPiAgentCapabilitiesFromSessionSetup(sessionSetupResult);
  const modelsFromState = buildPiAgentModelsFromSessionModelState(
    sessionSetupResult.models,
    capabilities,
  );
  if (modelsFromState.length > 1) {
    return { models: modelsFromState, capabilities };
  }
  const modelsFromConfig = buildPiAgentModelsFromSessionConfigOptions(
    sessionSetupResult.configOptions,
    capabilities,
  );
  return {
    models:
      modelsFromConfig.length > 0 ? modelsFromConfig : [buildPiAgentDefaultModel(capabilities)],
    capabilities,
  };
}

export function buildInitialPiAgentProviderSnapshot(
  piAgentSettings: PiAgentSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = piAgentModelsFromSettings(piAgentSettings.customModels);

    if (!piAgentSettings.enabled) {
      return buildServerProvider({
        presentation: PI_AGENT_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi Agent is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: PI_AGENT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Pi ACP adapter availability...",
      },
    });
  });
}

export function buildReadyPiAgentProviderSnapshot(input: {
  readonly checkedAt: string;
  readonly version: string | null;
  readonly models: ReadonlyArray<ServerProviderModel>;
}): ServerProviderDraft {
  return buildServerProvider({
    presentation: PI_AGENT_PRESENTATION,
    enabled: true,
    checkedAt: input.checkedAt,
    models: input.models,
    probe: {
      installed: true,
      version: input.version,
      status: "ready",
      auth: { status: "unknown", type: "pi-acp" },
    },
  });
}

const runPiAgentCommand = (
  piAgentSettings: PiAgentSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const commandArgs = [...splitPiAgentLaunchArgs(piAgentSettings.launchArgs), ...args];
    const spawnCommand = yield* resolveSpawnCommand(piAgentSettings.binaryPath, commandArgs, {
      env: environment,
    });
    const child = yield* spawner.spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, code: exitCode };
  }).pipe(Effect.scoped);

const discoverPiAgentModelsViaAcp = (
  piAgentSettings: PiAgentSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtime = yield* makePiAgentAcpRuntime({
      piAgentSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* runtime.start();
    return buildPiAgentDiscoveryFromSessionSetup(started.sessionSetupResult);
  }).pipe(Effect.scoped);

function piAgentStartFailureMessage(cause: Cause.Cause<unknown>): {
  readonly installed: boolean;
  readonly message: string;
} {
  const detail = Cause.pretty(cause);
  const lower = detail.toLowerCase();
  if (lower.includes("enoent") || lower.includes("notfound")) {
    return {
      installed: false,
      message: "Pi ACP adapter (`pi-acp`) is not installed or not on PATH.",
    };
  }
  if (
    lower.includes("auth") ||
    lower.includes("login") ||
    lower.includes("credential") ||
    lower.includes("api key")
  ) {
    return {
      installed: true,
      message: `Pi ACP adapter started but Pi authentication/setup failed. Run \`pi-acp --terminal-login\` or launch \`pi\` once in a terminal, then retry. ${PI_AGENT_PERMISSION_WARNING}`,
    };
  }
  return {
    installed: true,
    message: `Pi ACP adapter started but ACP setup failed. ${detail}`,
  };
}

export const checkPiAgentProviderStatus = Effect.fn("checkPiAgentProviderStatus")(function* (
  piAgentSettings: PiAgentSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = piAgentModelsFromSettings(piAgentSettings.customModels);

  if (!piAgentSettings.enabled) {
    return buildServerProvider({
      presentation: PI_AGENT_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi Agent is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runPiAgentCommand(piAgentSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(PI_AGENT_VERSION_TIMEOUT_MS),
    Effect.result,
  );
  let version: string | null = null;
  if (Result.isSuccess(versionResult) && Option.isSome(versionResult.success)) {
    const output = versionResult.success.value;
    version = parseGenericCliVersion(`${output.stdout}\n${output.stderr}`);
  } else if (
    Result.isFailure(versionResult) &&
    isCommandMissingCause(versionResult.failure as { readonly message: string })
  ) {
    return buildServerProvider({
      presentation: PI_AGENT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi ACP adapter (`pi-acp`) is not installed or not on PATH.",
      },
    });
  }

  const discoveryExit = yield* discoverPiAgentModelsViaAcp(piAgentSettings, environment).pipe(
    Effect.timeoutOption(PI_AGENT_ACP_START_TIMEOUT_MS),
    Effect.exit,
  );

  if (Exit.isFailure(discoveryExit)) {
    const failure = piAgentStartFailureMessage(discoveryExit.cause);
    return buildServerProvider({
      presentation: PI_AGENT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: failure.installed,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: failure.message,
      },
    });
  }

  if (Option.isNone(discoveryExit.value)) {
    return buildServerProvider({
      presentation: PI_AGENT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Pi ACP adapter timed out during ACP startup after ${PI_AGENT_ACP_START_TIMEOUT_MS}ms.`,
      },
    });
  }

  const discovery = discoveryExit.value.value;
  const models =
    discovery.models.length > 0
      ? piAgentModelsFromSettings(
          piAgentSettings.customModels,
          discovery.models,
          discovery.capabilities,
        )
      : fallbackModels;

  return buildReadyPiAgentProviderSnapshot({
    checkedAt,
    version,
    models,
  });
});

export const enrichPiAgentSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => input.publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Pi Agent version advisory enrichment failed", {
        cause: Cause.pretty(cause),
      }),
    ),
    Effect.asVoid,
  );
