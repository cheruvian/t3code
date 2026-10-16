import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.effect(
  "backfills item counts and maintains membership atomically without recounting streamed items",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 67 });
      const insert = (id: string, threadId: string, runId: string | null) => sql`
      INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
      VALUES (${id}, ${threadId}, ${runId}, 1, 'assistant_message', 'running', '2026-10-15', '{}')
      ON CONFLICT(turn_item_id) DO UPDATE SET
        thread_id = excluded.thread_id, run_id = excluded.run_id, payload_json = excluded.payload_json
    `;
      yield* insert("one", "thread:a", "run:a");
      yield* insert("two", "thread:a", "run:a");
      yield* insert("runless-one", "thread:a", null);
      yield* insert("runless-two", "thread:a", null);
      yield* runMigrations({ toMigrationInclusive: 68 });
      const counts = sql`
      SELECT thread_id, run_id, item_count FROM orchestration_v2_projection_item_counts
      ORDER BY thread_id, run_id
    `;
      assert.deepEqual(yield* counts, [
        { thread_id: "thread:a", run_id: null, item_count: 2 },
        { thread_id: "thread:a", run_id: "run:a", item_count: 2 },
      ]);

      // Upserts include membership columns even when only the streaming payload changed.
      // Fail if those writes touch the summary, keeping the hot path free of count writes.
      yield* sql`
      CREATE TEMP TRIGGER reject_count_update BEFORE UPDATE ON orchestration_v2_projection_item_counts
      BEGIN SELECT RAISE(ABORT, 'stream updates must not touch item counts'); END
    `;
      yield* insert("one", "thread:a", "run:a");
      yield* sql`UPDATE orchestration_v2_projection_turn_items
      SET payload_json = '{"text":"streamed"}', status = 'completed' WHERE turn_item_id = 'one'`;
      yield* sql`DROP TRIGGER reject_count_update`;

      yield* insert("three", "thread:a", "run:a");
      yield* insert("one", "thread:b", "run:b");
      yield* insert("runless-one", "thread:a", "run:a");
      yield* insert("two", "thread:b", null);
      assert.deepEqual(yield* counts, [
        { thread_id: "thread:a", run_id: null, item_count: 1 },
        { thread_id: "thread:a", run_id: "run:a", item_count: 2 },
        { thread_id: "thread:b", run_id: null, item_count: 1 },
        { thread_id: "thread:b", run_id: "run:b", item_count: 1 },
      ]);

      yield* sql
        .withTransaction(
          insert("rolled-back", "thread:a", "run:a").pipe(Effect.andThen(Effect.fail("rollback"))),
        )
        .pipe(
          Effect.flip,
          Effect.map((error) => assert.equal(error, "rollback")),
        );
      assert.deepEqual(
        yield* sql`SELECT item_count FROM orchestration_v2_projection_item_counts
      WHERE thread_id = 'thread:a' AND run_id = 'run:a'`,
        [{ item_count: 2 }],
      );

      yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE thread_id = 'thread:a'`;
      assert.deepEqual(yield* counts, [
        { thread_id: "thread:b", run_id: null, item_count: 1 },
        { thread_id: "thread:b", run_id: "run:b", item_count: 1 },
      ]);
      yield* sql`DELETE FROM orchestration_v2_projection_turn_items`;
      assert.deepEqual(yield* counts, []);
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 68 }), []);
    }).pipe(Effect.provide(Layer.fresh(NodeSqliteClient.layer({ filename: ":memory:" })))),
);
