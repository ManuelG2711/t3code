import { type PiAgentSettings, ProviderDriverKind } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";

import { ServerConfig } from "../../config.ts";
import { makeGenericAcpProviderAdapter } from "../acp/AcpProviderAdapter.ts";
import {
  applyPiAgentAcpModelSelection,
  makePiAgentAcpRuntime,
  PI_AGENT_DEFAULT_MODEL,
} from "../acp/PiAgentAcpSupport.ts";
import {
  findT3CodePreviewBridgeServer,
  preparePiPreviewBridge,
} from "../piAgent/PiPreviewBridge.ts";
import type { PiAgentAdapterShape } from "../Services/PiAgentAdapter.ts";

const PROVIDER = ProviderDriverKind.make("piAgent");

export interface PiAgentAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: import("./EventNdjsonLogger.ts").EventNdjsonLogger;
  readonly instanceId?: import("@t3tools/contracts").ProviderInstanceId;
}

export interface PreparePiAgentRuntimeEnvironmentInput {
  readonly baseEnvironment?: NodeJS.ProcessEnv | undefined;
  readonly fileSystem: FileSystem.FileSystem;
  readonly mcpServers?: ReadonlyArray<unknown> | undefined;
  readonly path: Path.Path;
  readonly platform: NodeJS.Platform;
  readonly stateDir: string;
}

export const preparePiAgentRuntimeEnvironment = (
  input: PreparePiAgentRuntimeEnvironmentInput,
): Effect.Effect<NodeJS.ProcessEnv | undefined, EffectAcpErrors.AcpSpawnError> =>
  Effect.gen(function* () {
    const previewBridgeServer = findT3CodePreviewBridgeServer(input.mcpServers);
    if (!previewBridgeServer) return input.baseEnvironment;

    const previewBridge = yield* preparePiPreviewBridge({
      environment: input.baseEnvironment ?? process.env,
      fileSystem: input.fileSystem,
      path: input.path,
      platform: input.platform,
      server: previewBridgeServer,
      stateDir: input.stateDir,
    }).pipe(
      Effect.mapError(
        (cause: PlatformError) =>
          new EffectAcpErrors.AcpSpawnError({
            command: "pi-acp",
            cause,
          }),
      ),
    );
    return previewBridge.environment;
  });

export function makePiAgentAdapter(
  piAgentSettings: PiAgentSettings,
  options?: PiAgentAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const platform = yield* HostProcessPlatform;
    const adapter = yield* makeGenericAcpProviderAdapter({
      provider: PROVIDER,
      providerLabel: "Pi Agent",
      defaultModel: PI_AGENT_DEFAULT_MODEL,
      ...(options?.instanceId ? { instanceId: options.instanceId } : {}),
      ...(options?.environment ? { environment: options.environment } : {}),
      ...(options?.nativeEventLogPath ? { nativeEventLogPath: options.nativeEventLogPath } : {}),
      ...(options?.nativeEventLogger ? { nativeEventLogger: options.nativeEventLogger } : {}),
      makeRuntime: (input) =>
        Effect.gen(function* () {
          const runtimeEnvironment = yield* preparePiAgentRuntimeEnvironment({
            baseEnvironment: options?.environment,
            fileSystem,
            mcpServers: input.mcpServers,
            path,
            platform,
            stateDir: serverConfig.stateDir,
          });
          return yield* makePiAgentAcpRuntime({
            piAgentSettings,
            ...(runtimeEnvironment ? { environment: runtimeEnvironment } : {}),
            childProcessSpawner,
            cwd: input.cwd,
            ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
          });
        }),
      applyModelSelection: ({ runtime, model, selections }) =>
        applyPiAgentAcpModelSelection({
          runtime,
          model,
          selections,
          mapError: (cause) => cause,
        }),
    });
    return adapter satisfies PiAgentAdapterShape;
  });
}
