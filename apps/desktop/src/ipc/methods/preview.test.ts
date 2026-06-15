import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { EnvironmentId } from "@t3tools/contracts";
import type { Session } from "electron";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as PreviewManager from "../../preview/Manager.ts";
import * as PreviewIpc from "./preview.ts";

const PREVIEW_USER_AGENT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.207 Safari/537.36";

const { fromPartition } = vi.hoisted(() => ({
  fromPartition: vi.fn(() => {
    throw new Error("Session can only be received when app is ready");
  }),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  session: {
    fromPartition,
  },
  webContents: {
    fromId: vi.fn(() => null),
  },
}));

describe("preview IPC methods", () => {
  beforeEach(() => {
    fromPartition.mockClear();
  });

  it("does not access the Electron session while the module loads", async () => {
    await expect(import("./preview.ts")).resolves.toBeDefined();
    expect(fromPartition).not.toHaveBeenCalled();
  });

  effectIt.effect("rejects invalid webContents ids before resolving the preview service", () =>
    Effect.map(
      PreviewIpc.registerWebview
        .handler({ tabId: "tab-1", webContentsId: 0 })
        .pipe(Effect.provideService(PreviewManager.PreviewManager, null as never), Effect.exit),
      (exit) => {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error) && Schema.isSchemaError(error.value)).toBe(true);
        expect(fromPartition).not.toHaveBeenCalled();
      },
    ),
  );

  effectIt.effect("returns the preview user agent in webview config", () =>
    Effect.gen(function* () {
      const manager = {
        getBrowserSession: vi.fn(() =>
          Effect.succeed({
            getUserAgent: () => PREVIEW_USER_AGENT,
          } as Session),
        ),
        getBrowserPartition: vi.fn(() => Effect.succeed("persist:t3code-preview-v2-test")),
      };

      const config = (yield* PreviewIpc.getPreviewConfig
        .handler({
          environmentId: EnvironmentId.make("environment-1"),
        })
        .pipe(Effect.provideService(PreviewManager.PreviewManager, manager as never))) as {
        readonly partition: string;
        readonly userAgent: string;
        readonly preloadUrl: unknown;
      };

      expect(config).toMatchObject({
        partition: "persist:t3code-preview-v2-test",
        userAgent: PREVIEW_USER_AGENT,
      });
      expect(typeof config.preloadUrl).toBe("string");
    }),
  );

  effectIt.effect("returns preview diagnostics for a tab", () =>
    Effect.gen(function* () {
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
          sessionUserAgent: PREVIEW_USER_AGENT,
          webContentsUserAgent: PREVIEW_USER_AGENT,
          lastMainFrameRequest: null,
        },
        guest: {
          userAgent: PREVIEW_USER_AGENT,
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
      const manager = {
        getDiagnostics: vi.fn(() => Effect.succeed(diagnostics)),
      };

      const result = yield* PreviewIpc.getDiagnostics
        .handler({ tabId: "tab_1" })
        .pipe(Effect.provideService(PreviewManager.PreviewManager, manager as never));

      expect(result).toEqual(diagnostics);
      expect(manager.getDiagnostics).toHaveBeenCalledWith("tab_1");
    }),
  );
});
