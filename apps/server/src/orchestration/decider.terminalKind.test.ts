import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const now = "2026-01-01T00:00:00.000Z";

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

const seedReadModel = Effect.gen(function* () {
  const initial = createEmptyReadModel(now);
  return yield* projectEvent(initial, {
    sequence: 1,
    eventId: asEventId("evt-project-create"),
    aggregateKind: "project",
    aggregateId: asProjectId("project-terminal"),
    type: "project.created",
    occurredAt: now,
    commandId: asCommandId("cmd-project-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project-create"),
    metadata: {},
    payload: {
      projectId: asProjectId("project-terminal"),
      title: "Project Terminal",
      workspaceRoot: "/tmp/project-terminal",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
});

it.layer(NodeServices.layer)("terminal thread kind", (it) => {
  it.effect("thread.create with kind 'terminal' emits thread.created carrying that kind", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: asCommandId("cmd-terminal-create"),
          threadId: asThreadId("thread-terminal"),
          projectId: asProjectId("project-terminal"),
          title: "Terminal",
          modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          kind: "terminal",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event?.type).toBe("thread.created");
      if (event?.type === "thread.created") {
        expect(event.payload.kind).toBe("terminal");
      }
    }),
  );

  it.effect("rejects thread.turn.start on a terminal thread", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const created = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: asCommandId("cmd-terminal-create-2"),
          threadId: asThreadId("thread-terminal-2"),
          projectId: asProjectId("project-terminal"),
          title: "Terminal",
          modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          kind: "terminal",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        readModel,
      });
      const createdEvents = Array.isArray(created) ? created : [created];
      let nextReadModel = readModel;
      let sequence = readModel.snapshotSequence;
      for (const event of createdEvents) {
        sequence += 1;
        nextReadModel = yield* projectEvent(nextReadModel, { ...event, sequence });
      }

      const turnStart: Extract<OrchestrationCommand, { type: "thread.turn.start" }> = {
        type: "thread.turn.start",
        commandId: asCommandId("cmd-terminal-turn"),
        threadId: asThreadId("thread-terminal-2"),
        message: {
          messageId: MessageId.make("msg-terminal"),
          role: "user",
          text: "should not run",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      };

      const error = yield* Effect.flip(
        decideOrchestrationCommand({ command: turnStart, readModel: nextReadModel }),
      );
      expect(error.message).toContain("terminal thread");
    }),
  );
});
