import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE server_drain_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      snapshot_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE server_owner_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      owner_generation TEXT NOT NULL
    )
  `;
});
