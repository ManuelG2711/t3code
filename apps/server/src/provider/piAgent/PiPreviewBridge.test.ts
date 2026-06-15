import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewAutomationExecutionError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import type * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";
import {
  bridgeUrlFromMcpEndpoint,
  findT3CodePreviewBridgeServer,
  preparePiPreviewBridge,
} from "./PiPreviewBridge.ts";
import { __testing as httpTesting, executePiPreviewBridgeOperation } from "./PiPreviewHttp.ts";

const TestLayer = NodeServices.layer;

const makeMcpScope = (
  capabilities: ReadonlySet<McpInvocationContext.McpCapability> = new Set(["preview"]),
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-test"),
  threadId: ThreadId.make("thread-test"),
  providerSessionId: "provider-session-test",
  providerInstanceId: ProviderInstanceId.make("piagent"),
  capabilities,
  issuedAt: 0,
  expiresAt: 1,
});

it("finds authenticated t3-code MCP servers for Pi preview bridging", () => {
  expect(
    findT3CodePreviewBridgeServer([
      {
        type: "http",
        name: "t3-code",
        url: "http://127.0.0.1:4123/mcp",
        headers: [{ name: "Authorization", value: "Bearer provider-token" }],
      },
    ]),
  ).toEqual({
    endpoint: "http://127.0.0.1:4123/mcp",
    authorizationHeader: "Bearer provider-token",
  });

  expect(
    findT3CodePreviewBridgeServer([
      {
        type: "http",
        name: "t3-code",
        url: "http://127.0.0.1:4123/mcp",
        headers: [],
      },
    ]),
  ).toBeUndefined();
});

it.effect("writes the Pi extension and wrapper while preserving an existing Pi command", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-pi-preview-bridge-test-",
    });

    const result = yield* preparePiPreviewBridge({
      environment: {
        PI_ACP_PI_COMMAND: "custom-pi",
      },
      fileSystem,
      path,
      platform: "win32",
      stateDir,
      server: {
        endpoint: "http://127.0.0.1:5151/mcp",
        authorizationHeader: "Bearer provider-token",
      },
    });

    expect(result.bridgeUrl).toBe("http://127.0.0.1:5151/api/provider/pi-preview");
    expect(result.environment.PI_ACP_PI_COMMAND).toBe(result.wrapperPath);
    expect(result.environment.T3_PI_PREVIEW_ORIGINAL_PI_COMMAND).toBe("custom-pi");
    expect(result.environment.T3_PI_PREVIEW_EXTENSION_PATH).toBe(result.extensionPath);
    expect(result.environment.T3_PI_PREVIEW_AUTHORIZATION).toBe("Bearer provider-token");

    const extensionSource = yield* fileSystem.readFileString(result.extensionPath);
    const wrapperSource = yield* fileSystem.readFileString(result.wrapperPath);
    expect(extensionSource).toContain("preview_snapshot");
    expect(extensionSource).toContain("preview_recording_stop");
    expect(wrapperSource).toContain("T3_PI_PREVIEW_EXTENSION_PATH");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it("derives the internal bridge URL from the MCP endpoint origin", () => {
  expect(bridgeUrlFromMcpEndpoint("http://localhost:3000/mcp")).toBe(
    "http://localhost:3000/api/provider/pi-preview",
  );
});

it("summarizes snapshots without returning screenshot base64 data", () => {
  const result = httpTesting.normalizeResult("snapshot", {
    url: "http://example.test/",
    title: "Example",
    loading: false,
    visibleText: "Example",
    interactiveElements: [],
    accessibilityTree: {},
    consoleEntries: [],
    networkEntries: [],
    actionTimeline: [],
    screenshot: {
      mimeType: "image/png",
      data: "base64-data",
      width: 320,
      height: 200,
    },
  });

  expect(result).toMatchObject({
    url: "http://example.test/",
    screenshot: {
      mimeType: "image/png",
      width: 320,
      height: 200,
    },
  });
  expect(JSON.stringify(result)).not.toContain("base64-data");
});

it.effect("rejects Pi preview bridge requests without a valid bearer token", () =>
  executePiPreviewBridgeOperation({
    operation: "status",
    authorizationHeader: undefined,
    body: {},
    resolveScope: () =>
      Effect.sync((): McpInvocationContext.McpInvocationScope | undefined => undefined),
    invoke: () => Effect.die("unexpected broker invocation"),
  }).pipe(
    Effect.map((result) => {
      expect(result.status).toBe(401);
      expect(result.body).toEqual({
        ok: false,
        error: {
          tag: "PiPreviewBridgeUnauthorized",
          message: "A valid provider-scoped preview bearer credential is required.",
        },
      });
    }),
  ),
);

it.effect("rejects Pi preview bridge scopes without preview capability", () =>
  executePiPreviewBridgeOperation({
    operation: "status",
    authorizationHeader: "Bearer provider-token",
    body: {},
    resolveScope: () => Effect.succeed(makeMcpScope(new Set())),
    invoke: () => Effect.die("unexpected broker invocation"),
  }).pipe(
    Effect.map((result) => {
      expect(result.status).toBe(403);
      expect(result.body).toMatchObject({
        ok: false,
        error: { tag: "PiPreviewBridgeForbidden" },
      });
    }),
  ),
);

it.effect("invokes the preview broker with the decoded operation input", () => {
  let captured: PreviewAutomationBroker.PreviewAutomationInvokeInput | undefined;

  return executePiPreviewBridgeOperation({
    operation: "navigate",
    authorizationHeader: "Bearer provider-token",
    body: { url: "http://example.test", timeoutMs: 123 },
    resolveScope: (rawToken) => {
      expect(rawToken).toBe("provider-token");
      return Effect.succeed(makeMcpScope());
    },
    invoke: (request) => {
      captured = request;
      return Effect.succeed({ url: "http://example.test/" });
    },
  }).pipe(
    Effect.map((result) => {
      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        ok: true,
        result: { url: "http://example.test/" },
      });
      expect(captured?.operation).toBe("navigate");
      expect(captured?.timeoutMs).toBe(123);
      expect(captured?.input).toEqual({
        url: "http://example.test",
        timeoutMs: 123,
      });
    }),
  );
});

it.effect("normalizes preview broker errors into stable bridge JSON", () =>
  executePiPreviewBridgeOperation({
    operation: "evaluate",
    authorizationHeader: "Bearer provider-token",
    body: { expression: "document.title" },
    resolveScope: () => Effect.succeed(makeMcpScope()),
    invoke: () =>
      Effect.fail(
        new PreviewAutomationExecutionError({
          message: "Evaluation failed.",
          detail: { reason: "test" },
        }),
      ),
  }).pipe(
    Effect.map((result) => {
      expect(result.status).toBe(502);
      expect(result.body).toEqual({
        ok: false,
        error: {
          tag: "PreviewAutomationExecutionError",
          message: "Evaluation failed.",
          detail: { reason: "test" },
        },
      });
    }),
  ),
);
