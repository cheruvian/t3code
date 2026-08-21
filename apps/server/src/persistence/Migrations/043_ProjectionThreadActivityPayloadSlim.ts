import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Pre-slimmed activity payloads, written next to the full `payload_json` so a
 * thread open reads only what it will ship. Both columns stay NULL on existing
 * rows: reads fall back to slimming `payload_json` whenever
 * `payload_slim_version` does not match the current slimming rules, so no
 * backfill is required for correctness.
 */
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
