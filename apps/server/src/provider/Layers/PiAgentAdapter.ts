import { type PiAgentSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeGenericAcpProviderAdapter } from "../acp/AcpProviderAdapter.ts";
import {
  applyPiAgentAcpModelSelection,
  makePiAgentAcpRuntime,
  PI_AGENT_DEFAULT_MODEL,
} from "../acp/PiAgentAcpSupport.ts";
import type { PiAgentAdapterShape } from "../Services/PiAgentAdapter.ts";

const PROVIDER = ProviderDriverKind.make("piAgent");

export interface PiAgentAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: import("./EventNdjsonLogger.ts").EventNdjsonLogger;
  readonly instanceId?: import("@t3tools/contracts").ProviderInstanceId;
}

export function makePiAgentAdapter(
  piAgentSettings: PiAgentSettings,
  options?: PiAgentAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const adapter = yield* makeGenericAcpProviderAdapter({
      provider: PROVIDER,
      providerLabel: "Pi Agent",
      defaultModel: PI_AGENT_DEFAULT_MODEL,
      ...(options?.instanceId ? { instanceId: options.instanceId } : {}),
      ...(options?.environment ? { environment: options.environment } : {}),
      ...(options?.nativeEventLogPath ? { nativeEventLogPath: options.nativeEventLogPath } : {}),
      ...(options?.nativeEventLogger ? { nativeEventLogger: options.nativeEventLogger } : {}),
      makeRuntime: (input) =>
        makePiAgentAcpRuntime({
          piAgentSettings,
          ...(options?.environment ? { environment: options.environment } : {}),
          childProcessSpawner,
          cwd: input.cwd,
          ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
          clientInfo: { name: "t3-code", version: "0.0.0" },
          ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
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
