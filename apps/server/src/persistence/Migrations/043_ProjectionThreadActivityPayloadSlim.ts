import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Reads fall back to slimming payload_json when the stored slim version is absent or stale. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_activities)
  `;

  if (!columns.some((column) => column.name === "payload_slim_json")) {
    yield* sql`
      ALTER TABLE projection_thread_activities
      ADD COLUMN payload_slim_json TEXT
    `;
  }

  if (!columns.some((column) => column.name === "payload_slim_version")) {
    yield* sql`
      ALTER TABLE projection_thread_activities
      ADD COLUMN payload_slim_version INTEGER
    `;
  }
});
