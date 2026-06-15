import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";

export const PI_PREVIEW_BRIDGE_ROUTE_PREFIX = "/api/provider/pi-preview";
const BRIDGE_DIR_NAME = "pi-preview-bridge";
const EXTENSION_FILE_NAME = "t3-pi-preview-extension.js";

export interface PiPreviewBridgeServer {
  readonly endpoint: string;
  readonly authorizationHeader: string;
}

export interface PiPreviewBridgeResult {
  readonly environment: NodeJS.ProcessEnv;
  readonly bridgeUrl: string;
  readonly extensionPath: string;
  readonly wrapperPath: string;
}

export interface PreparePiPreviewBridgeInput {
  readonly environment: NodeJS.ProcessEnv;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly platform: NodeJS.Platform;
  readonly server: PiPreviewBridgeServer;
  readonly stateDir: string;
}

const jsonSchema = (properties: Record<string, unknown>, required: ReadonlyArray<string> = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: true,
});

const extensionSource = String.raw`
const bridgeUrl = process.env.T3_PI_PREVIEW_BRIDGE_URL;
const authorization = process.env.T3_PI_PREVIEW_AUTHORIZATION;

const emptySchema = { type: "object", properties: {}, additionalProperties: true };
const optionalTimeout = { type: "number", description: "Maximum wait in milliseconds." };
const locatorFields = {
  selector: { type: "string", description: "CSS selector. Prefer locator when possible." },
  locator: { type: "string", description: "Playwright selector such as role=button[name='Send']." },
};
const schemas = {
  preview_status: emptySchema,
  preview_open: {
    type: "object",
    properties: {
      url: { type: "string" },
      show: { type: "boolean" },
      reuseExistingTab: { type: "boolean" },
    },
    additionalProperties: true,
  },
  preview_navigate: {
    type: "object",
    properties: {
      url: { type: "string" },
      target: { type: "object", additionalProperties: true },
      readiness: { type: "string", enum: ["load", "domContentLoaded", "none"] },
      timeoutMs: optionalTimeout,
    },
    additionalProperties: true,
  },
  preview_snapshot: emptySchema,
  preview_click: {
    type: "object",
    properties: { ...locatorFields, x: { type: "number" }, y: { type: "number" }, timeoutMs: optionalTimeout },
    additionalProperties: true,
  },
  preview_type: {
    type: "object",
    properties: { ...locatorFields, text: { type: "string" }, clear: { type: "boolean" }, timeoutMs: optionalTimeout },
    required: ["text"],
    additionalProperties: true,
  },
  preview_press: {
    type: "object",
    properties: {
      key: { type: "string" },
      modifiers: { type: "array", items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift"] } },
    },
    required: ["key"],
    additionalProperties: true,
  },
  preview_scroll: {
    type: "object",
    properties: { ...locatorFields, deltaX: { type: "number" }, deltaY: { type: "number" } },
    additionalProperties: true,
  },
  preview_evaluate: {
    type: "object",
    properties: {
      expression: { type: "string" },
      awaitPromise: { type: "boolean" },
      returnByValue: { type: "boolean" },
    },
    required: ["expression"],
    additionalProperties: true,
  },
  preview_wait_for: {
    type: "object",
    properties: { ...locatorFields, text: { type: "string" }, urlIncludes: { type: "string" }, timeoutMs: optionalTimeout },
    additionalProperties: true,
  },
  preview_recording_start: emptySchema,
  preview_recording_stop: emptySchema,
};

const tools = [
  ["preview_status", "status", "Report whether the T3 Code collaborative browser is available, visible, loading, and which tab/URL/title is active."],
  ["preview_open", "open", "Show and initialize the T3 Code collaborative browser, optionally opening a URL."],
  ["preview_navigate", "navigate", "Navigate the active T3 Code browser tab. Use url for websites or target for environment ports."],
  ["preview_snapshot", "snapshot", "Inspect the current browser page. Returns URL, title, visible text, interactive elements, console/network failures, action history, and screenshot metadata."],
  ["preview_click", "click", "Click one browser target by locator, selector, or viewport coordinates. Call preview_snapshot first when unsure."],
  ["preview_type", "type", "Type literal text into a browser input selected by locator/selector, or the focused element."],
  ["preview_press", "press", "Press one keyboard key in the active browser page."],
  ["preview_scroll", "scroll", "Scroll the browser viewport or a selected scrollable element."],
  ["preview_evaluate", "evaluate", "Evaluate a JavaScript expression in the active browser page."],
  ["preview_wait_for", "waitFor", "Wait for a selector, locator, visible text, or URL substring in the browser page."],
  ["preview_recording_start", "recordingStart", "Start recording the active collaborative browser tab."],
  ["preview_recording_stop", "recordingStop", "Stop browser recording and return the saved artifact."],
];

function textForResult(toolName, result) {
  if (result === undefined || result === null) return "OK";
  return JSON.stringify(result, null, 2);
}

async function callBridge(operation, params, signal) {
  if (!bridgeUrl || !authorization) {
    throw new Error("T3 Code preview bridge is not configured for this Pi session.");
  }
  const response = await fetch(bridgeUrl + "/" + operation, {
    method: "POST",
    headers: {
      "authorization": authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify(params ?? {}),
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (!payload || payload.ok !== true) {
    const message = payload?.error?.message ?? "T3 Code preview bridge failed with HTTP " + response.status + ".";
    const error = new Error(message);
    error.name = payload?.error?.tag ?? "PreviewAutomationExecutionError";
    error.detail = payload?.error?.detail;
    throw error;
  }
  return payload.result;
}

export default function t3PiPreviewExtension(pi) {
  for (const [name, operation, description] of tools) {
    pi.registerTool({
      name,
      label: name.replace(/^preview_/, "preview "),
      description,
      promptSnippet: description,
      parameters: schemas[name] ?? emptySchema,
      async execute(_toolCallId, params, signal) {
        const result = await callBridge(operation, params, signal);
        return {
          content: [{ type: "text", text: textForResult(name, result) }],
          details: result,
        };
      },
    });
  }
}
`;

function windowsWrapperSource(): string {
  return [
    "@echo off",
    "setlocal",
    'set "T3_PI_CMD=%T3_PI_PREVIEW_ORIGINAL_PI_COMMAND%"',
    'if "%T3_PI_CMD%"=="" set "T3_PI_CMD=pi"',
    '"%T3_PI_CMD%" --extension "%T3_PI_PREVIEW_EXTENSION_PATH%" %*',
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}

function posixWrapperSource(): string {
  return [
    "#!/usr/bin/env sh",
    "set -eu",
    'T3_PI_CMD="${T3_PI_PREVIEW_ORIGINAL_PI_COMMAND:-pi}"',
    'exec "$T3_PI_CMD" --extension "$T3_PI_PREVIEW_EXTENSION_PATH" "$@"',
    "",
  ].join("\n");
}

function isHttpMcpServer(server: unknown): server is {
  readonly name?: unknown;
  readonly url?: unknown;
  readonly headers?: unknown;
} {
  return typeof server === "object" && server !== null && "url" in server;
}

export function findT3CodePreviewBridgeServer(
  mcpServers: ReadonlyArray<unknown> | undefined,
): PiPreviewBridgeServer | undefined {
  const server = mcpServers?.find(
    (entry) =>
      isHttpMcpServer(entry) &&
      entry.name === "t3-code" &&
      typeof entry.url === "string" &&
      entry.url.trim().length > 0,
  );
  if (!server || !isHttpMcpServer(server) || typeof server.url !== "string") return undefined;
  const headers = Array.isArray(server.headers) ? server.headers : [];
  const authorizationHeader = headers
    .map((header) =>
      typeof header === "object" &&
      header !== null &&
      "name" in header &&
      "value" in header &&
      typeof header.name === "string" &&
      typeof header.value === "string" &&
      header.name.toLowerCase() === "authorization"
        ? header.value
        : undefined,
    )
    .find((value): value is string => value !== undefined && value.trim().length > 0);
  if (!authorizationHeader) return undefined;
  return {
    endpoint: server.url,
    authorizationHeader,
  };
}

export function bridgeUrlFromMcpEndpoint(endpoint: string): string {
  return new URL(PI_PREVIEW_BRIDGE_ROUTE_PREFIX, endpoint).toString().replace(/\/$/, "");
}

export const preparePiPreviewBridge = (
  input: PreparePiPreviewBridgeInput,
): Effect.Effect<PiPreviewBridgeResult, PlatformError> =>
  Effect.gen(function* () {
    const bridgeDir = input.path.join(input.stateDir, BRIDGE_DIR_NAME);
    const extensionPath = input.path.join(bridgeDir, EXTENSION_FILE_NAME);
    const wrapperPath = input.path.join(
      bridgeDir,
      input.platform === "win32" ? "t3-pi-preview.cmd" : "t3-pi-preview",
    );
    yield* input.fileSystem.makeDirectory(bridgeDir, { recursive: true });
    yield* input.fileSystem.writeFileString(extensionPath, extensionSource.trimStart());
    yield* input.fileSystem.writeFileString(
      wrapperPath,
      input.platform === "win32" ? windowsWrapperSource() : posixWrapperSource(),
    );
    if (input.platform !== "win32") {
      yield* input.fileSystem.chmod(wrapperPath, 0o755);
    }

    const bridgeUrl = bridgeUrlFromMcpEndpoint(input.server.endpoint);
    return {
      bridgeUrl,
      extensionPath,
      wrapperPath,
      environment: {
        ...input.environment,
        PI_ACP_PI_COMMAND: wrapperPath,
        T3_PI_PREVIEW_ORIGINAL_PI_COMMAND: input.environment.PI_ACP_PI_COMMAND ?? "",
        T3_PI_PREVIEW_BRIDGE_URL: bridgeUrl,
        T3_PI_PREVIEW_AUTHORIZATION: input.server.authorizationHeader,
        T3_PI_PREVIEW_EXTENSION_PATH: extensionPath,
      },
    } satisfies PiPreviewBridgeResult;
  });

export const __testing = {
  extensionSource,
  windowsWrapperSource,
  posixWrapperSource,
  jsonSchema,
};
