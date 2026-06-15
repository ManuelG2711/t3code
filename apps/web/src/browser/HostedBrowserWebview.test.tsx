import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const PREVIEW_USER_AGENT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.207 Safari/537.36";

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: {
    createTab: vi.fn(async () => undefined),
    closeTab: vi.fn(async () => undefined),
    registerWebview: vi.fn(async () => undefined),
  },
}));

vi.mock("~/components/preview/usePreviewBridge", () => ({
  usePreviewBridge: vi.fn(),
}));

vi.mock("./previewWebviewConfigState", () => ({
  usePreviewWebviewConfig: vi.fn(() => ({
    partition: "persist:t3code-preview-v2-test",
    userAgent: PREVIEW_USER_AGENT,
    webPreferences: "contextIsolation=false,sandbox=true,nodeIntegration=false",
    preloadUrl: "file:///preview-pick-preload.cjs",
  })),
}));

import { HostedBrowserWebview } from "./HostedBrowserWebview";

describe("HostedBrowserWebview", () => {
  it("passes the preview user agent to the Electron webview", () => {
    const markup = renderToStaticMarkup(
      <HostedBrowserWebview
        threadRef={{
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
        }}
        tabId="tab_1"
        initialUrl="https://web.whatsapp.com/"
      />,
    );

    expect(markup).toContain(`useragent="${PREVIEW_USER_AGENT}"`);
    expect(markup).toContain('src="about:blank"');
    expect(markup).not.toContain("https://web.whatsapp.com/");
  });
});
