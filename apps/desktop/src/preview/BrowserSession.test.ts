import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const { fromPartition, sessions } = vi.hoisted(() => ({
  fromPartition: vi.fn(),
  sessions: new Map<
    string,
    {
      readonly clearCache: ReturnType<typeof vi.fn>;
      readonly clearStorageData: ReturnType<typeof vi.fn>;
      readonly getUserAgent: ReturnType<typeof vi.fn>;
      readonly setPermissionRequestHandler: ReturnType<typeof vi.fn>;
      readonly setUserAgent: ReturnType<typeof vi.fn>;
      readonly webRequest: {
        readonly onBeforeSendHeaders: ReturnType<typeof vi.fn>;
      };
    }
  >(),
}));

vi.mock("electron", () => ({
  session: {
    fromPartition,
  },
}));

import * as BrowserSession from "./BrowserSession.ts";

const layer = BrowserSession.layer.pipe(Layer.provide(NodeServices.layer));
const PREVIEW_USER_AGENT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.207 Safari/537.36";

describe("BrowserSession", () => {
  beforeEach(() => {
    sessions.clear();
    fromPartition.mockReset();
    fromPartition.mockImplementation((partition: string) => {
      const browserSession = {
        clearCache: vi.fn(() => Promise.resolve()),
        clearStorageData: vi.fn(() => Promise.resolve()),
        getUserAgent: vi.fn(
          () =>
            "Mozilla/5.0 AppleWebKit/537.36 t3code/0.0.27 Chrome/140.0.7339.207 Electron/41.5.0 Safari/537.36",
        ),
        setPermissionRequestHandler: vi.fn(),
        setUserAgent: vi.fn(),
        webRequest: {
          onBeforeSendHeaders: vi.fn(),
        },
      };
      sessions.set(partition, browserSession);
      return browserSession;
    });
  });

  it.effect("derives deterministic partitions and memoizes sessions", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;

      const partition = yield* browserSessions.getPartition("scope-a");
      const first = yield* browserSessions.getSession("scope-a");
      const second = yield* browserSessions.getSession("scope-a");

      assert.strictEqual(partition, "persist:t3code-preview-v2-f051bb2c68cb7b2fe969");
      assert.strictEqual(first, second);
      assert.strictEqual(fromPartition.mock.calls.length, 1);
      const mockSession = sessions.get(partition);
      assert.isDefined(mockSession);
      assert.deepEqual(mockSession.setUserAgent.mock.calls[0], [PREVIEW_USER_AGENT]);
      assert.strictEqual(mockSession.webRequest.onBeforeSendHeaders.mock.calls.length, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rewrites preview request UA client hint headers", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");

      yield* browserSessions.getSession("scope-a");

      const mockSession = sessions.get(partition);
      assert.isDefined(mockSession);
      const listener = mockSession.webRequest.onBeforeSendHeaders.mock.calls[0]?.[0];
      assert.isFunction(listener);
      const callback = vi.fn();
      listener(
        {
          requestHeaders: {
            "user-agent": "Mozilla/5.0 Electron/41.5.0",
            "sec-ch-ua": '"Electron";v="41"',
          },
        },
        callback,
      );

      assert.deepInclude(callback.mock.calls[0]?.[0]?.requestHeaders, {
        "User-Agent": PREVIEW_USER_AGENT,
        "sec-ch-ua": '"Google Chrome";v="140", "Chromium";v="140", "Not=A?Brand";v="24"',
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("clears storage and cache for every created session", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      yield* browserSessions.getSession("scope-a");
      yield* browserSessions.getSession("scope-b");

      yield* browserSessions.clearCookies();
      yield* browserSessions.clearCache();

      assert.strictEqual(sessions.size, 2);
      for (const browserSession of sessions.values()) {
        assert.strictEqual(browserSession.clearStorageData.mock.calls.length, 1);
        assert.deepEqual(browserSession.clearStorageData.mock.calls[0], [
          {
            storages: [
              "cookies",
              "localstorage",
              "indexdb",
              "websql",
              "serviceworkers",
              "cachestorage",
            ],
          },
        ]);
        assert.strictEqual(browserSession.clearCache.mock.calls.length, 1);
      }
    }).pipe(Effect.provide(layer)),
  );
});
