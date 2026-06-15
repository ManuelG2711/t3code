import { describe, expect, it, vi } from "vite-plus/test";

import { copyPreviewDiagnostics } from "./copyPreviewDiagnostics";

describe("copyPreviewDiagnostics", () => {
  it("copies formatted preview diagnostics JSON", async () => {
    const diagnostics = {
      createdAt: "2026-06-15T12:00:00.000Z",
      app: {
        isPackaged: true,
        isDevelopment: false,
        version: "0.0.27",
        appPath: "C:/Program Files/T3 Code",
        appRoot: "C:/Program Files/T3 Code/resources/app.asar",
        commitHash: "abcdef123456",
        previewCompatibilityVersion: "preview-browser-identity-v1",
      },
      runtime: {
        electron: "41.5.0",
        chromium: "140.0.7339.207",
        node: "24.13.1",
        platform: "win32",
        arch: "x64",
      },
      preview: {
        tabId: "tab_1",
        webContentsId: 42,
        url: "https://web.whatsapp.com/",
        title: "WhatsApp",
        loading: false,
        partition: "persist:t3code-preview-v2-test",
        sessionUserAgent: "Mozilla/5.0 Chrome/140.0.7339.207 Safari/537.36",
        webContentsUserAgent: "Mozilla/5.0 Chrome/140.0.7339.207 Safari/537.36",
        lastMainFrameRequest: null,
      },
      guest: {
        userAgent: "Mozilla/5.0 Chrome/140.0.7339.207 Safari/537.36",
        appVersion: null,
        userAgentData: null,
        highEntropyUserAgentData: null,
        platform: "Win32",
        vendor: "Google Inc.",
        webdriver: false,
        languages: ["en-US", "en"],
        pluginsLength: 2,
        mimeTypesLength: 2,
        hasWindowChrome: true,
        windowChromeKeys: ["runtime"],
        hasProcess: false,
        hasRequire: false,
        hasBuffer: false,
        serviceWorkerAvailable: true,
        indexedDbAvailable: true,
      },
    };
    const bridge = {
      getDiagnostics: vi.fn(async () => diagnostics),
    };
    const writeText = vi.fn(async () => undefined);

    await expect(
      copyPreviewDiagnostics({
        bridge: bridge as never,
        tabId: "tab_1",
        writeText,
      }),
    ).resolves.toEqual(diagnostics);

    expect(bridge.getDiagnostics).toHaveBeenCalledWith("tab_1");
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(diagnostics, null, 2));
  });
});
