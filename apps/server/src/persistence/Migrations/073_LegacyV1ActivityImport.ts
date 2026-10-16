import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE orchestration_v2_legacy_imports ADD COLUMN activity_imported_at TEXT`;
  yield* sql`CREATE INDEX orchestration_v2_legacy_imports_pending_activity_idx
    ON orchestration_v2_legacy_imports(shell_imported_at, thread_id)
    WHERE activity_imported_at IS NULL`;
});
