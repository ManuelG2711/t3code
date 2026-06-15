import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopPreviewDiagnosticsSchema } from "./ipc.ts";

const decodeDesktopPreviewDiagnostics = Schema.decodeUnknownSync(DesktopPreviewDiagnosticsSchema);

describe("DesktopPreviewDiagnosticsSchema", () => {
  it("decodes preview diagnostics with provenance and guest identity", () => {
    const diagnostics = decodeDesktopPreviewDiagnostics({
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
        lastMainFrameRequest: {
          url: "https://web.whatsapp.com/",
          method: "GET",
          headers: {
            "User-Agent": "Mozilla/5.0 Chrome/140.0.7339.207 Safari/537.36",
          },
        },
      },
      guest: {
        userAgent: "Mozilla/5.0 Chrome/140.0.7339.207 Safari/537.36",
        appVersion: "5.0 Chrome/140.0.7339.207 Safari/537.36",
        userAgentData: { brands: [{ brand: "Google Chrome", version: "140" }] },
        highEntropyUserAgentData: { platform: "Windows" },
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
    });

    expect(diagnostics.app.previewCompatibilityVersion).toBe("preview-browser-identity-v1");
    expect(diagnostics.preview.lastMainFrameRequest?.headers["User-Agent"]).toContain("Chrome");
  });
});
