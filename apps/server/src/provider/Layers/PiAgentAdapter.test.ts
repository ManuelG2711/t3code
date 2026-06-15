import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { preparePiAgentRuntimeEnvironment } from "./PiAgentAdapter.ts";

const TestLayer = NodeServices.layer;

it.effect(
  "injects the Pi preview bridge environment when the t3-code MCP session is available",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-pi-agent-adapter-test-",
      });

      const environment = yield* preparePiAgentRuntimeEnvironment({
        baseEnvironment: {
          KEEP_ME: "yes",
          PI_ACP_PI_COMMAND: "custom-pi",
        },
        fileSystem,
        mcpServers: [
          {
            type: "http",
            name: "t3-code",
            url: "http://127.0.0.1:5151/mcp",
            headers: [{ name: "Authorization", value: "Bearer provider-token" }],
          },
        ],
        path,
        platform: "win32",
        stateDir,
      });

      expect(environment?.KEEP_ME).toBe("yes");
      expect(environment?.PI_ACP_PI_COMMAND).toContain("t3-pi-preview.cmd");
      expect(environment?.T3_PI_PREVIEW_ORIGINAL_PI_COMMAND).toBe("custom-pi");
      expect(environment?.T3_PI_PREVIEW_BRIDGE_URL).toBe(
        "http://127.0.0.1:5151/api/provider/pi-preview",
      );
      expect(environment?.T3_PI_PREVIEW_AUTHORIZATION).toBe("Bearer provider-token");
      expect(environment?.T3_PI_PREVIEW_EXTENSION_PATH).toContain("t3-pi-preview-extension.js");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect(
  "leaves the Pi runtime environment unchanged without an authenticated t3-code MCP session",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-pi-agent-adapter-test-",
      });
      const baseEnvironment = { KEEP_ME: "yes" };

      const environment = yield* preparePiAgentRuntimeEnvironment({
        baseEnvironment,
        fileSystem,
        mcpServers: [
          {
            type: "http",
            name: "t3-code",
            url: "http://127.0.0.1:5151/mcp",
            headers: [],
          },
        ],
        path,
        platform: "win32",
        stateDir,
      });

      expect(environment).toBe(baseEnvironment);
      expect(environment?.PI_ACP_PI_COMMAND).toBeUndefined();
      expect(environment?.T3_PI_PREVIEW_BRIDGE_URL).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);
