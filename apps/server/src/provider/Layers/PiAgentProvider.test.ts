import { describe, expect, it } from "@effect/vitest";
import { PiAgentSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  buildPiAgentCapabilitiesFromSessionSetup,
  buildPiAgentDiscoveryFromSessionSetup,
  buildInitialPiAgentProviderSnapshot,
  buildPiAgentModelsFromSessionConfigOptions,
  buildPiAgentModelsFromSessionModelState,
  buildReadyPiAgentProviderSnapshot,
  piAgentModelsFromSettings,
} from "./PiAgentProvider.ts";

const decodePiAgentSettings = Schema.decodeSync(PiAgentSettings);

describe("buildInitialPiAgentProviderSnapshot", () => {
  it.effect("returns a disabled snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiAgentProviderSnapshot(decodePiAgentSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.showInteractionModeToggle).toBe(false);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending enabled snapshot without exposing approval-mode toggles", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiAgentProviderSnapshot(
        decodePiAgentSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.showInteractionModeToggle).toBe(false);
      expect(snapshot.message).toContain("Pi ACP adapter");
    }),
  );
});

describe("buildReadyPiAgentProviderSnapshot", () => {
  it("returns a selectable ready snapshot without the permission warning as a blocking message", () => {
    const snapshot = buildReadyPiAgentProviderSnapshot({
      checkedAt: "2026-06-15T12:00:00.000Z",
      version: "0.1.0",
      models: piAgentModelsFromSettings([]),
    });

    expect(snapshot.enabled).toBe(true);
    expect(snapshot.installed).toBe(true);
    expect(snapshot.status).toBe("ready");
    expect(snapshot.auth).toEqual({ status: "unknown", type: "pi-acp" });
    expect(snapshot.message).toBeUndefined();
    expect(snapshot.showInteractionModeToggle).toBe(false);
  });
});

describe("Pi Agent model catalog helpers", () => {
  it("falls back to the Pi default model when ACP exposes no catalog", () => {
    expect(piAgentModelsFromSettings([]).map((model) => model.slug)).toEqual(["default"]);
  });

  it("uses ACP session/new models when the adapter reports them while preserving Pi default", () => {
    const models = buildPiAgentModelsFromSessionModelState({
      currentModelId: "pi-fast",
      availableModels: [
        { modelId: "pi-fast", name: "Pi Fast" },
        { modelId: "pi-deep", name: "Pi Deep" },
        { modelId: "pi-fast", name: "Duplicate" },
      ],
    } as EffectAcpSchema.SessionModelState);

    expect(models).toMatchObject([
      { slug: "default", name: "Pi default", isCustom: false },
      { slug: "pi-fast", name: "Pi Fast", isCustom: false },
      { slug: "pi-deep", name: "Pi Deep", isCustom: false },
    ]);
  });

  it("builds ACP model catalog from model config options", () => {
    const models = buildPiAgentModelsFromSessionConfigOptions([
      {
        id: "model",
        name: "Model",
        type: "select",
        category: "model",
        currentValue: "openai/gpt-5",
        options: [
          { value: "openai/gpt-5", name: "GPT-5" },
          { value: "openai/o4-mini", name: "o4 mini" },
        ],
      },
    ] as ReadonlyArray<EffectAcpSchema.SessionConfigOption>);

    expect(models).toMatchObject([
      { slug: "default", name: "Pi default", isCustom: false },
      { slug: "openai/gpt-5", name: "GPT-5", isCustom: false },
      { slug: "openai/o4-mini", name: "o4 mini", isCustom: false },
    ]);
  });

  it("exposes thought-level config options as model capabilities", () => {
    const capabilities = buildPiAgentCapabilitiesFromSessionSetup({
      sessionId: "pi-session",
      configOptions: [
        {
          id: "thinking",
          name: "Thinking",
          type: "select",
          category: "thought_level",
          currentValue: "medium",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ],
    } as EffectAcpSchema.NewSessionResponse);

    expect(capabilities.optionDescriptors).toMatchObject([
      {
        id: "thinking",
        type: "select",
        label: "Thinking",
        currentValue: "medium",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
    ]);
  });

  it("falls back to session modes as reasoning capabilities", () => {
    const discovery = buildPiAgentDiscoveryFromSessionSetup({
      sessionId: "pi-session",
      modes: {
        currentModeId: "balanced",
        availableModes: [
          { id: "balanced", name: "Balanced" },
          { id: "deep", name: "Deep" },
        ],
      },
    } as EffectAcpSchema.NewSessionResponse);

    expect(discovery.models[0]?.capabilities?.optionDescriptors).toMatchObject([
      {
        id: "piAgentMode",
        type: "select",
        label: "Reasoning",
        currentValue: "balanced",
        options: [
          { id: "balanced", label: "Balanced" },
          { id: "deep", label: "Deep" },
        ],
      },
    ]);
  });

  it("merges custom models after ACP-discovered built-ins", () => {
    const builtIns = buildPiAgentModelsFromSessionModelState({
      currentModelId: "pi-fast",
      availableModels: [{ modelId: "pi-fast", name: "Pi Fast" }],
    } as EffectAcpSchema.SessionModelState);

    expect(
      piAgentModelsFromSettings(["custom/pi-lab"], builtIns).map((model) => model.slug),
    ).toEqual(["default", "pi-fast", "custom/pi-lab"]);
  });
});
