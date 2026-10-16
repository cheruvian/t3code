import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE orchestration_v2_projection_item_counts (
      thread_id TEXT NOT NULL,
      run_id TEXT,
      item_count INTEGER NOT NULL CHECK (item_count >= 0),
      UNIQUE (thread_id, run_id)
    )
  `;
  // SQLite treats NULLs as distinct in UNIQUE constraints; runless items share one bucket.
  yield* sql`
    CREATE UNIQUE INDEX orchestration_v2_projection_item_counts_runless_idx
    ON orchestration_v2_projection_item_counts(thread_id) WHERE run_id IS NULL
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_item_counts(thread_id, run_id, item_count)
    SELECT thread_id, run_id, COUNT(*) FROM orchestration_v2_projection_turn_items
    GROUP BY thread_id, run_id
  `;
  // Maintain membership in the same transaction as the projection. Streaming payload/status
  // updates do not change counts, and deletes also cover pruning and projection rebuilds.
  yield* sql`
    CREATE TRIGGER orchestration_v2_item_counts_insert
    AFTER INSERT ON orchestration_v2_projection_turn_items
    BEGIN
      INSERT INTO orchestration_v2_projection_item_counts(thread_id, run_id, item_count)
      VALUES (NEW.thread_id, NEW.run_id, 1)
      ON CONFLICT DO UPDATE SET item_count = item_count + 1;
    END
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_item_counts_delete
    AFTER DELETE ON orchestration_v2_projection_turn_items
    BEGIN
      UPDATE orchestration_v2_projection_item_counts SET item_count = item_count - 1
      WHERE thread_id = OLD.thread_id AND run_id IS OLD.run_id;
      DELETE FROM orchestration_v2_projection_item_counts
      WHERE thread_id = OLD.thread_id AND run_id IS OLD.run_id AND item_count = 0;
    END
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_item_counts_move
    AFTER UPDATE OF thread_id, run_id ON orchestration_v2_projection_turn_items
    WHEN OLD.thread_id IS NOT NEW.thread_id OR OLD.run_id IS NOT NEW.run_id
    BEGIN
      UPDATE orchestration_v2_projection_item_counts SET item_count = item_count - 1
      WHERE thread_id = OLD.thread_id AND run_id IS OLD.run_id;
      DELETE FROM orchestration_v2_projection_item_counts
      WHERE thread_id = OLD.thread_id AND run_id IS OLD.run_id AND item_count = 0;
      INSERT INTO orchestration_v2_projection_item_counts(thread_id, run_id, item_count)
      VALUES (NEW.thread_id, NEW.run_id, 1)
      ON CONFLICT DO UPDATE SET item_count = item_count + 1;
    END
  `;
  // Idle threads have no current runs: do not walk completed history to discover that.
  yield* sql`
    CREATE INDEX orchestration_v2_runs_current_idx
    ON orchestration_v2_projection_runs(thread_id, ordinal DESC, run_id DESC)
    WHERE status IN ('preparing', 'starting', 'running', 'waiting')
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_messages_latest_authored_idx
    ON orchestration_v2_projection_messages(thread_id, updated_at DESC, message_id DESC)
    WHERE role = 'user' AND json_extract(payload_json, '$.createdBy') = 'user'
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_items_latest_failure_idx
    ON orchestration_v2_projection_turn_items(
      thread_id, run_id, node_id, updated_at DESC, ordinal DESC, turn_item_id DESC
    )
    WHERE type = 'error' AND status = 'failed'
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_items_waiting_secret_idx
    ON orchestration_v2_projection_turn_items(thread_id, run_id, updated_at DESC, turn_item_id DESC)
    WHERE type = 'secret_request' AND status = 'waiting'
  `;
});
