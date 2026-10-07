import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX orchestration_v2_workspace_move_fence_idx
    ON orchestration_v2_projection_threads(json_extract(payload_json, '$.worktreePath'))
    WHERE deleted_at IS NULL AND json_extract(payload_json, '$.environmentMove') IS NOT NULL`;
});
