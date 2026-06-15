import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyPiAgentAcpModelSelection,
  buildPiAgentAcpSpawnInput,
  PI_AGENT_MODE_OPTION_ID,
  resolvePiAgentAuthMethodId,
  resolvePiAgentBaseModelId,
  splitPiAgentLaunchArgs,
} from "./PiAgentAcpSupport.ts";
import type { AcpSessionRuntimeShape } from "./AcpSessionRuntime.ts";

describe("splitPiAgentLaunchArgs", () => {
  it("splits shell-like launch args for npx-based pi-acp installs", () => {
    expect(splitPiAgentLaunchArgs(' -y "pi-acp" --profile work\\ space ')).toEqual([
      "-y",
      "pi-acp",
      "--profile",
      "work space",
    ]);
  });
});

describe("buildPiAgentAcpSpawnInput", () => {
  it("uses pi-acp by default and preserves launch args", () => {
    expect(
      buildPiAgentAcpSpawnInput({ binaryPath: "npx", launchArgs: "-y pi-acp" }, "/tmp/project", {
        PI_HOME: "/tmp/pi",
      }),
    ).toEqual({
      command: "npx",
      args: ["-y", "pi-acp"],
      cwd: "/tmp/project",
      env: { PI_HOME: "/tmp/pi" },
    });
  });
});

describe("resolvePiAgentAuthMethodId", () => {
  it("prefers ACP terminal auth when the adapter advertises it", () => {
    expect(
      resolvePiAgentAuthMethodId({
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [{ id: "terminal-login", name: "Terminal", type: "terminal" }],
      }),
    ).toBe("terminal-login");
  });

  it("falls back to terminal when initialize omits auth methods", () => {
    expect(
      resolvePiAgentAuthMethodId({
        protocolVersion: 1,
        agentCapabilities: {},
      }),
    ).toBe("terminal");
  });
});

describe("applyPiAgentAcpModelSelection", () => {
  const makeRecordingRuntime = (input?: {
    readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
    readonly setConfigOptionFailure?: EffectAcpErrors.AcpError;
    readonly setSessionModelFailure?: EffectAcpErrors.AcpError;
  }) => {
    const setSessionModelCalls: Array<string> = [];
    const setConfigOptionCalls: Array<{ id: string; value: string | boolean }> = [];
    const setSessionModeCalls: Array<string> = [];
    const runtime: Pick<
      AcpSessionRuntimeShape,
      "getConfigOptions" | "getModeState" | "setConfigOption" | "setSessionMode" | "setSessionModel"
    > = {
      getConfigOptions: Effect.succeed(input?.configOptions ?? []),
      getModeState: Effect.sync((): undefined => undefined),
      setConfigOption: (id: string, value: string | boolean) =>
        Effect.gen(function* () {
          setConfigOptionCalls.push({ id, value });
          if (input?.setConfigOptionFailure) return yield* input.setConfigOptionFailure;
          return { configOptions: [] };
        }),
      setSessionMode: (modeId: string) =>
        Effect.sync(() => {
          setSessionModeCalls.push(modeId);
          return {};
        }),
      setSessionModel: (modelId: string) =>
        Effect.gen(function* () {
          setSessionModelCalls.push(modelId);
          if (input?.setSessionModelFailure) return yield* input.setSessionModelFailure;
          return {};
        }),
    };
    return { runtime, setConfigOptionCalls, setSessionModeCalls, setSessionModelCalls };
  };

  it.effect("uses the default Pi model when no model is selected", () =>
    Effect.gen(function* () {
      const { runtime, setConfigOptionCalls, setSessionModeCalls, setSessionModelCalls } =
        makeRecordingRuntime();
      const result = yield* applyPiAgentAcpModelSelection({
        runtime,
        model: undefined,
        mapError: (cause) => cause.message,
      });
      expect(result).toBe("default");
      expect(setConfigOptionCalls).toEqual([]);
      expect(setSessionModeCalls).toEqual([]);
      expect(setSessionModelCalls).toEqual([]);
    }),
  );

  it("normalizes custom Pi model ids through provider-aware slugs", () => {
    expect(resolvePiAgentBaseModelId("anthropic/claude-sonnet-4-6")).toBe(
      "anthropic/claude-sonnet-4-6",
    );
    expect(resolvePiAgentBaseModelId("  default  ")).toBe("default");
  });

  it.effect("uses session/set_model for explicit models that are not ACP config options", () =>
    Effect.gen(function* () {
      const { runtime, setConfigOptionCalls, setSessionModelCalls } = makeRecordingRuntime();
      const result = yield* applyPiAgentAcpModelSelection({
        runtime,
        model: "pi/remote-model",
        mapError: (cause) => cause.message,
      });
      expect(result).toBe("pi/remote-model");
      expect(setConfigOptionCalls).toEqual([]);
      expect(setSessionModelCalls).toEqual(["pi/remote-model"]);
    }),
  );

  it.effect("uses announced model config options and falls back to session/set_model", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.methodNotFound("session/set_config_option");
      const { runtime, setConfigOptionCalls, setSessionModelCalls } = makeRecordingRuntime({
        setConfigOptionFailure: failure,
        configOptions: [
          {
            id: "model",
            name: "Model",
            type: "select",
            category: "model",
            currentValue: "default",
            options: [{ value: "pi/remote-model", name: "Remote" }],
          },
        ],
      });
      const result = yield* applyPiAgentAcpModelSelection({
        runtime,
        model: "pi/remote-model",
        mapError: (cause) => cause.message,
      });
      expect(result).toBe("pi/remote-model");
      expect(setConfigOptionCalls).toEqual([{ id: "model", value: "pi/remote-model" }]);
      expect(setSessionModelCalls).toEqual(["pi/remote-model"]);
    }),
  );

  it.effect("applies thought-level config option selections", () =>
    Effect.gen(function* () {
      const { runtime, setConfigOptionCalls } = makeRecordingRuntime({
        configOptions: [
          {
            id: "thinking",
            name: "Reasoning",
            type: "select",
            category: "thought_level",
            currentValue: "medium",
            options: [{ value: "high", name: "High" }],
          },
        ],
      });
      yield* applyPiAgentAcpModelSelection({
        runtime,
        model: "default",
        selections: [{ id: "thinking", value: "high" }],
        mapError: (cause) => cause.message,
      });
      expect(setConfigOptionCalls).toEqual([{ id: "thinking", value: "high" }]);
    }),
  );

  it.effect("applies mode-backed reasoning selections through session/set_mode", () =>
    Effect.gen(function* () {
      const { runtime, setSessionModeCalls } = makeRecordingRuntime();
      yield* applyPiAgentAcpModelSelection({
        runtime,
        model: "default",
        selections: [{ id: PI_AGENT_MODE_OPTION_ID, value: "deep" }],
        mapError: (cause) => cause.message,
      });
      expect(setSessionModeCalls).toEqual(["deep"]);
    }),
  );
});
