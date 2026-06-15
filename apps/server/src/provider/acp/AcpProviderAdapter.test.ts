import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type * as EffectAcpSchema from "effect-acp/schema";

import { ServerConfig } from "../../config.ts";
import type { AcpSessionRuntimeShape } from "./AcpSessionRuntime.ts";
import { makeGenericAcpProviderAdapter } from "./AcpProviderAdapter.ts";
import type { AcpParsedSessionEvent } from "./AcpRuntimeModel.ts";

const PI_AGENT = ProviderDriverKind.make("piAgent");

function makeNoopHandler() {
  return () => Effect.void;
}

describe("makeGenericAcpProviderAdapter", () => {
  const testLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "generic-acp-provider-adapter-test",
  }).pipe(Layer.provideMerge(NodeServices.layer));

  it.effect(
    "starts, resumes, streams prompt events, cancels, and records turns through a mock ACP runtime",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-pi-agent-acp-test");
        const runtimeEvents = yield* PubSub.unbounded<AcpParsedSessionEvent>();
        const prompts: Array<ReadonlyArray<EffectAcpSchema.ContentBlock>> = [];
        const loadedSessionIds: Array<string | undefined> = [];
        let cancelCount = 0;

        const adapter = yield* makeGenericAcpProviderAdapter({
          provider: PI_AGENT,
          providerLabel: "Pi Agent",
          defaultModel: "default",
          makeRuntime: ({ resumeSessionId }): Effect.Effect<AcpSessionRuntimeShape> =>
            Effect.sync(() => {
              loadedSessionIds.push(resumeSessionId);
              return {
                handleRequestPermission: makeNoopHandler(),
                handleElicitation: makeNoopHandler(),
                handleReadTextFile: makeNoopHandler(),
                handleWriteTextFile: makeNoopHandler(),
                handleCreateTerminal: makeNoopHandler(),
                handleTerminalOutput: makeNoopHandler(),
                handleTerminalWaitForExit: makeNoopHandler(),
                handleTerminalKill: makeNoopHandler(),
                handleTerminalRelease: makeNoopHandler(),
                handleSessionUpdate: makeNoopHandler(),
                handleElicitationComplete: makeNoopHandler(),
                handleUnknownExtRequest: makeNoopHandler(),
                handleUnknownExtNotification: makeNoopHandler(),
                handleExtRequest: makeNoopHandler(),
                handleExtNotification: makeNoopHandler(),
                start: () =>
                  Effect.succeed({
                    sessionId: resumeSessionId ?? "pi-session-1",
                    initializeResult: {
                      protocolVersion: 1,
                      agentCapabilities: {},
                    },
                    sessionSetupResult: {},
                    modelConfigId: undefined,
                  }),
                getEvents: () => Stream.fromPubSub(runtimeEvents),
                getModeState: Effect.void,
                getConfigOptions: Effect.succeed([]),
                prompt: (payload: Omit<EffectAcpSchema.PromptRequest, "sessionId">) =>
                  Effect.gen(function* () {
                    prompts.push(payload.prompt);
                    yield* PubSub.publish(runtimeEvents, {
                      _tag: "ContentDelta",
                      text: "hello from pi",
                      rawPayload: { sessionUpdate: "agent_message_chunk" },
                    });
                    yield* PubSub.publish(runtimeEvents, {
                      _tag: "ToolCallUpdated",
                      toolCall: {
                        toolCallId: "tool-1",
                        title: "Inspect",
                        status: "completed",
                        data: {},
                      },
                      rawPayload: { sessionUpdate: "tool_call_update" },
                    });
                    return { stopReason: "end_turn" };
                  }),
                cancel: Effect.sync(() => {
                  cancelCount += 1;
                }),
                setMode: () => Effect.succeed({}),
                setSessionMode: () => Effect.succeed({}),
                setConfigOption: () => Effect.succeed({}),
                setModel: () => Effect.void,
                setSessionModel: () => Effect.succeed({}),
                request: () => Effect.succeed({}),
                notify: () => Effect.void,
              } as unknown as AcpSessionRuntimeShape;
            }),
        });

        const firstSession = yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        expect(firstSession.resumeCursor).toEqual({
          schemaVersion: 1,
          sessionId: "pi-session-1",
        });

        yield* adapter.stopSession(threadId);
        const resumedSession = yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          resumeCursor: firstSession.resumeCursor,
        });
        expect(resumedSession.resumeCursor).toEqual(firstSession.resumeCursor);
        expect(loadedSessionIds).toEqual([undefined, "pi-session-1"]);

        const collectedFiber = yield* Stream.runCollect(
          Stream.take(
            Stream.filter(
              adapter.streamEvents,
              (event) => event.type === "content.delta" || event.type === "item.completed",
            ),
            2,
          ),
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        const turn = yield* adapter.sendTurn({
          threadId,
          input: "hello",
        });
        expect(turn.resumeCursor).toEqual(firstSession.resumeCursor);
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toEqual([{ type: "text", text: "hello" }]);

        const events = Array.from(yield* Fiber.join(collectedFiber));
        expect(events.map((event) => event.type).toSorted()).toEqual([
          "content.delta",
          "item.completed",
        ]);

        yield* adapter.interruptTurn(threadId);
        expect(cancelCount).toBe(1);

        const snapshot = yield* adapter.readThread(threadId);
        expect(snapshot.turns).toHaveLength(1);
      }).pipe(Effect.provide(testLayer)),
  );
});
