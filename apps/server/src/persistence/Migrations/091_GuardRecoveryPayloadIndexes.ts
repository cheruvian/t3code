import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Recovery must inspect legacy rows even when an unrelated payload is malformed.
  yield* sql`DROP INDEX orchestration_v2_workspace_move_fence_idx`;
  yield* sql`CREATE INDEX orchestration_v2_workspace_move_fence_idx
    ON orchestration_v2_projection_threads(json_extract(payload_json, '$.worktreePath'))
    WHERE deleted_at IS NULL AND CASE WHEN json_valid(payload_json)
      THEN json_extract(payload_json, '$.environmentMove') IS NOT NULL ELSE 0 END`;
  yield* sql`DROP INDEX orchestration_v2_runs_latest_executed_idx`;
  yield* sql`CREATE INDEX orchestration_v2_runs_latest_executed_idx
    ON orchestration_v2_projection_runs(
      thread_id, (completed_at IS NULL) DESC, completed_at DESC, ordinal DESC, run_id DESC
    )
    WHERE status <> 'queued' AND CASE WHEN json_valid(payload_json)
      THEN NOT (status = 'cancelled' AND json_extract(payload_json, '$.startedAt') IS NULL)
      ELSE 0 END`;
});
