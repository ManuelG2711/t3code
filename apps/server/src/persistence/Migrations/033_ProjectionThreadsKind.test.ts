import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("033_ProjectionThreadsKind", (it) => {
  it.effect("adds the kind column and backfills existing rows to 'agent'", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Migrate up to just before this migration, then insert a pre-existing row
      // that has no `kind` column yet.
      yield* runMigrations({ toMigrationInclusive: 32 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'approval-required',
          'default',
          NULL,
          NULL,
          NULL,
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:00.000Z',
          NULL,
          NULL,
          0,
          0,
          0,
          NULL
        )
      `;

      yield* runMigrations();

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.isTrue(columns.some((column) => column.name === "kind"));

      const rows = yield* sql<{ readonly kind: string }>`
        SELECT kind FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.strictEqual(rows[0]?.kind, "agent");
    }),
  );
});
