import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Recovery scans only persisted usage-limit failures, not every thread.
  yield* sql`
    CREATE INDEX orchestration_v2_usage_limit_errors_idx
    ON orchestration_v2_projection_turn_items(thread_id, run_id)
    WHERE type = 'error' AND status = 'failed'
      AND json_extract(payload_json, '$.failure.class') = 'usage_limit'
      AND json_extract(payload_json, '$.failure.resetAt') IS NOT NULL
  `;
  // Match latestExecutedRun's ordering without sorting each thread's history.
  yield* sql`
    CREATE INDEX orchestration_v2_runs_latest_executed_idx
    ON orchestration_v2_projection_runs(
      thread_id, (completed_at IS NULL) DESC, completed_at DESC, ordinal DESC, run_id DESC
    )
    WHERE status <> 'queued'
      AND NOT (status = 'cancelled' AND json_extract(payload_json, '$.startedAt') IS NULL)
  `;
});
