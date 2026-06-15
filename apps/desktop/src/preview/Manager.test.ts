import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { beforeEach, describe, expect, vi } from "vite-plus/test";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as BrowserSession from "./BrowserSession.ts";
import * as PreviewManager from "./Manager.ts";

const { createFromPath, fromId, mkdir, showItemInFolder, webviewSend, writeFile, writeImage } =
  vi.hoisted(() => ({
    createFromPath: vi.fn(() => ({ isEmpty: () => false })),
    fromId: vi.fn(() => null),
    mkdir: vi.fn((_path: string) => undefined),
    showItemInFolder: vi.fn(),
    webviewSend: vi.fn(),
    writeFile: vi.fn((_path: string, _data: Uint8Array) => undefined),
    writeImage: vi.fn(),
  }));

vi.mock("electron", () => ({
  clipboard: {
    writeImage,
  },
  nativeImage: {
    createFromPath,
  },
  shell: {
    showItemInFolder,
  },
  session: {
    fromPartition: vi.fn(),
  },
  webContents: {
    fromId,
  },
}));

const browserSessionLayer = Layer.succeed(
  BrowserSession.BrowserSession,
  BrowserSession.BrowserSession.of({
    getPartition: () => Effect.succeed("persist:t3code-preview-v2-test"),
    isPartition: (partition) => partition.startsWith("persist:t3code-preview-v2-"),
    getSession: () => Effect.die("unexpected getSession"),
    clearCookies: () => Effect.void,
    clearCache: () => Effect.void,
  }),
);

const environmentLayer = Layer.succeed(
  DesktopEnvironment.DesktopEnvironment,
  DesktopEnvironment.DesktopEnvironment.of({
    isPackaged: true,
    isDevelopment: false,
    appVersion: "0.0.27",
    appPath: "/Applications/T3 Code.app",
    appRoot: "/Applications/T3 Code.app/Contents/Resources/app.asar",
    browserArtifactsDir: "/tmp/t3/dev/browser-artifacts",
  } as DesktopEnvironment.DesktopEnvironmentShape),
);

const fileSystemLayer = FileSystem.layerNoop({
  readFileString: (path) =>
    Effect.succeed(
      path.endsWith("package.json") ? '{"t3codeCommitHash":"abcdef1234567890"}' : "{}",
    ),
  makeDirectory: (path) =>
    Effect.sync(() => {
      mkdir(path);
    }),
  writeFile: (path, data) =>
    Effect.sync(() => {
      writeFile(path, data);
    }),
});

const layer = PreviewManager.layer.pipe(
  Layer.provideMerge(browserSessionLayer),
  Layer.provideMerge(environmentLayer),
  Layer.provideMerge(fileSystemLayer),
  Layer.provideMerge(Path.layer),
);
const PREVIEW_USER_AGENT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.207 Safari/537.36";

const withManager = <A>(
  use: (
    manager: PreviewManager.PreviewManagerShape,
  ) => Effect.Effect<A, PreviewManager.PreviewManagerError, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* use(manager);
  }).pipe(Effect.provide(layer), Effect.scoped);

describe("PreviewManager", () => {
  beforeEach(() => {
    fromId.mockClear();
    mkdir.mockClear();
    writeFile.mockClear();
    showItemInFolder.mockClear();
    writeImage.mockClear();
    createFromPath.mockClear();
    webviewSend.mockClear();
  });

  effectIt.effect("reports an unregistered webview as temporarily unavailable", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        expect(yield* manager.automationStatus("tab_1")).toEqual({
          available: false,
          visible: true,
          tabId: "tab_1",
          url: null,
          title: null,
          loading: false,
        });

        yield* manager.createTab("tab_1");

        expect(yield* manager.automationStatus("tab_1")).toEqual({
          available: false,
          visible: true,
          tabId: "tab_1",
          url: null,
          title: null,
          loading: false,
        });
        expect(fromId).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("sanitizes the registered webview user agent", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const setUserAgent = vi.fn();
        const sendCommand = vi.fn(async () => undefined);
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getUserAgent: () =>
            "Mozilla/5.0 AppleWebKit/537.36 t3code/0.0.27 Chrome/140.0.7339.207 Electron/41.5.0 Safari/537.36",
          setUserAgent,
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);

        expect(setUserAgent).toHaveBeenCalledWith(PREVIEW_USER_AGENT);
        yield* Effect.yieldNow;
        expect(sendCommand).toHaveBeenCalledWith(
          "Network.setUserAgentOverride",
          expect.objectContaining({
            platform: "Win32",
            userAgent: PREVIEW_USER_AGENT,
            userAgentMetadata: expect.objectContaining({
              brands: expect.arrayContaining([{ brand: "Google Chrome", version: "140" }]),
            }),
          }),
        );
      }),
    ),
  );

  effectIt.effect("captures a PNG screenshot into browser artifacts", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const png = Buffer.from("preview-png");
        const capturePage = vi.fn(async () => ({ toPNG: () => png }));
        const listeners = new Map<string, (...args: never[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getUserAgent: () => "Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0.7339.207 Safari/537.36",
          setUserAgent: vi.fn(),
          getURL: () => "https://example.com:8443/path?query=value",
          getTitle: () => "Example",
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn((event: string, listener: (...args: never[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
          capturePage,
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);

        expect(webviewSend).toHaveBeenCalledWith(
          "preview:annotation-theme",
          expect.objectContaining({
            colorScheme: "light",
            primary: "oklch(0.488 0.217 264)",
          }),
        );

        const artifact = yield* manager.captureScreenshot("tab_1");

        expect(capturePage).toHaveBeenCalledOnce();
        expect(mkdir).toHaveBeenCalledWith("/tmp/t3/dev/browser-artifacts");
        expect(writeFile).toHaveBeenCalledWith(artifact.path, png);
        expect(artifact).toMatchObject({
          tabId: "tab_1",
          mimeType: "image/png",
          sizeBytes: png.byteLength,
        });
        expect(artifact.path).toMatch(
          /\/browser-artifacts\/browser-screenshot-example-com-[^.]+\.png$/,
        );
      }),
    ),
  );

  effectIt.effect("collects preview diagnostics from the registered webview", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let debuggerMessage:
          | ((event: unknown, method: string, params: Record<string, unknown>) => void)
          | undefined;
        const guest = {
          userAgent: PREVIEW_USER_AGENT,
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
        };
        const sendCommand = vi.fn(async (method: string) => {
          if (method === "Runtime.evaluate") {
            return { result: { value: guest } };
          }
          return undefined;
        });
        fromId.mockReturnValue({
          id: 42,
          session: {
            partition: "persist:t3code-preview-v2-test",
            getUserAgent: () => PREVIEW_USER_AGENT,
          },
          isDestroyed: () => false,
          getType: () => "webview",
          getUserAgent: () => PREVIEW_USER_AGENT,
          setUserAgent: vi.fn(),
          getURL: () => "https://web.whatsapp.com/",
          getTitle: () => "WhatsApp",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn((_event: string, listener: typeof debuggerMessage) => {
              debuggerMessage = listener;
            }),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        yield* Effect.yieldNow;
        debuggerMessage?.({}, "Network.requestWillBeSent", {
          requestId: "request-1",
          type: "Document",
          request: {
            url: "https://web.whatsapp.com/",
            method: "GET",
            headers: {
              "User-Agent": PREVIEW_USER_AGENT,
              "sec-ch-ua": '"Google Chrome";v="140"',
            },
          },
        });
        yield* Effect.yieldNow;

        const diagnostics = yield* manager.getDiagnostics("tab_1");

        expect(diagnostics).toMatchObject({
          app: {
            isPackaged: true,
            version: "0.0.27",
            commitHash: "abcdef1234567890",
            previewCompatibilityVersion: "preview-browser-identity-v1",
          },
          preview: {
            tabId: "tab_1",
            webContentsId: 42,
            url: "https://web.whatsapp.com/",
            partition: "persist:t3code-preview-v2-test",
            sessionUserAgent: PREVIEW_USER_AGENT,
            webContentsUserAgent: PREVIEW_USER_AGENT,
            lastMainFrameRequest: {
              url: "https://web.whatsapp.com/",
              method: "GET",
              headers: expect.objectContaining({
                "User-Agent": PREVIEW_USER_AGENT,
              }),
            },
          },
          guest,
        });
      }),
    ),
  );

  effectIt.effect("reveals only files inside the configured browser artifact directory", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        yield* manager.revealArtifact("/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png");

        expect(showItemInFolder).toHaveBeenCalledWith(
          "/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png",
        );
        const exit = yield* Effect.exit(manager.revealArtifact("/tmp/t3/dev/settings.json"));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error.cause).toMatchObject({
          message: "Preview artifact path is outside the configured artifact directory.",
        });
      }),
    ),
  );

  effectIt.effect("copies screenshot artifacts to the system clipboard", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const artifactPath = "/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png";

        yield* manager.copyArtifactToClipboard(artifactPath);

        expect(createFromPath).toHaveBeenCalledWith(artifactPath);
        expect(writeImage).toHaveBeenCalledOnce();
        const exit = yield* Effect.exit(
          manager.copyArtifactToClipboard("/tmp/t3/dev/settings.json"),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error.cause).toMatchObject({
          message: "Preview artifact path is outside the configured artifact directory.",
        });
      }),
    ),
  );

  effectIt.effect("emits the resolved pointer target before dispatching an automation click", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let humanInput: ((_event: unknown, signal: unknown) => void) | undefined;
        const activity: string[] = [];
        const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
          if (method === "Runtime.evaluate") {
            return {
              result: {
                value: { width: 800, height: 600 },
              },
            };
          }
          if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
            activity.push("mousePressed");
            humanInput?.({}, { kind: "pointer", x: params.x, y: params.y, button: 0 });
          }
          return undefined;
        });
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getUserAgent: () => "Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0.7339.207 Safari/537.36",
          setUserAgent: vi.fn(),
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: {
            on: vi.fn((channel: string, listener: typeof humanInput) => {
              if (channel === "preview:human-input") humanInput = listener;
            }),
            off: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.subscribePointerEvents((event) => activity.push(event.phase));
        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const click = yield* manager
          .automationClick("tab_1", { x: 120, y: 80 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(200);
        yield* Fiber.join(click);

        expect(activity).toEqual(["move", "click", "mousePressed"]);
        expect(sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: 120,
          y: 80,
          button: "left",
          clickCount: 1,
        });
        expect(sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: 120,
          y: 80,
          button: "left",
          clickCount: 1,
        });
      }),
    ),
  );

  effectIt.effect("still interrupts agent control for a different human pointer event", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let humanInput: ((_event: unknown, signal: unknown) => void) | undefined;
        const sendCommand = vi.fn(async (method: string) => {
          if (method === "Runtime.evaluate") {
            return {
              result: {
                value: { width: 800, height: 600 },
              },
            };
          }
          if (method === "Input.dispatchMouseEvent") {
            humanInput?.({}, { kind: "pointer", x: 400, y: 300, button: 0 });
          }
          return undefined;
        });
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getUserAgent: () => "Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0.7339.207 Safari/537.36",
          setUserAgent: vi.fn(),
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: {
            on: vi.fn((channel: string, listener: typeof humanInput) => {
              if (channel === "preview:human-input") humanInput = listener;
            }),
            off: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);

        const click = yield* manager
          .automationClick("tab_1", { x: 120, y: 80 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(200);
        const exit = yield* Fiber.await(click);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error.cause).toMatchObject({
          name: "PreviewAutomationControlInterruptedError",
        });
      }),
    ),
  );
});
