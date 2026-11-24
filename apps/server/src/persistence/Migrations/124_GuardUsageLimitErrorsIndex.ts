import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX orchestration_v2_usage_limit_errors_idx`;
  yield* sql`
    CREATE INDEX orchestration_v2_usage_limit_errors_idx
    ON orchestration_v2_projection_turn_items(thread_id, run_id)
    WHERE type = 'error' AND status = 'failed'
      AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.failure.class') = 'usage_limit'
      AND json_extract(payload_json, '$.failure.resetAt') IS NOT NULL ELSE 0 END
  `;
});
