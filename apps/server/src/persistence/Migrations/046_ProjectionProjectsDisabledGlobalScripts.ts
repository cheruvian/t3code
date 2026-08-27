import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_projects)`;
  if (!columns.some((column) => column.name === "disabled_inherited_script_ids_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN disabled_inherited_script_ids_json TEXT NOT NULL DEFAULT '[]'
    `;
  }
});
