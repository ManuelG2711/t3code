import type { DesktopPreviewBridge, DesktopPreviewDiagnostics } from "@t3tools/contracts";

export async function copyPreviewDiagnostics(input: {
  readonly bridge: DesktopPreviewBridge;
  readonly tabId: string;
  readonly writeText: (text: string) => Promise<void>;
}): Promise<DesktopPreviewDiagnostics> {
  const diagnostics = await input.bridge.getDiagnostics(input.tabId);
  await input.writeText(JSON.stringify(diagnostics, null, 2));
  return diagnostics;
}
