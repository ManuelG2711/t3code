import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderState,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  describeModelPickerProviderInstanceTooltip,
  isModelPickerProviderInstanceUnavailable,
} from "./ModelPickerSidebar";

function piProvider(status: ServerProviderState, message?: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("piAgent"),
    driver: ProviderDriverKind.make("piAgent"),
    displayName: "Pi Agent",
    enabled: true,
    installed: true,
    version: null,
    status,
    auth: { status: "unknown", type: "pi-acp" },
    checkedAt: "2026-06-15T12:00:00.000Z",
    ...(message ? { message } : {}),
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("ModelPickerSidebar provider availability", () => {
  it("treats an operational Pi Agent provider as selectable instead of Limited", () => {
    const [entry] = deriveProviderInstanceEntries([piProvider("ready")]);
    expect(entry).toBeDefined();

    expect(isModelPickerProviderInstanceUnavailable(entry!)).toBe(false);
    expect(
      describeModelPickerProviderInstanceTooltip({
        entry: entry!,
        isUnavailable: false,
        isContextDisabled: false,
        isNew: false,
      }),
    ).toBe("Pi Agent");
  });

  it("still presents warning snapshots as Limited", () => {
    const [entry] = deriveProviderInstanceEntries([
      piProvider("warning", "Checking Pi ACP adapter availability..."),
    ]);
    expect(entry).toBeDefined();

    expect(isModelPickerProviderInstanceUnavailable(entry!)).toBe(true);
    expect(
      describeModelPickerProviderInstanceTooltip({
        entry: entry!,
        isUnavailable: true,
        isContextDisabled: false,
        isNew: false,
      }),
    ).toBe("Pi Agent — Limited. Checking Pi ACP adapter availability...");
  });
});
