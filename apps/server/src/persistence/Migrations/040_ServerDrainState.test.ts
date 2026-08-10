import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("040_ServerDrainState", (it) => {
  it.effect("persists at most one authoritative drain snapshot", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        INSERT INTO server_drain_state (singleton_id, snapshot_json)
        VALUES (1, '{"phase":"draining"}')
      `;
      yield* sql`
        INSERT INTO server_drain_state (singleton_id, snapshot_json)
        VALUES (1, '{"phase":"committing"}')
        ON CONFLICT (singleton_id) DO UPDATE SET snapshot_json = excluded.snapshot_json
      `;
      const rows = yield* sql<{ readonly snapshotJson: string }>`
        SELECT snapshot_json AS "snapshotJson" FROM server_drain_state
      `;
      assert.deepStrictEqual(rows, [{ snapshotJson: '{"phase":"committing"}' }]);
      yield* sql`
        INSERT INTO server_owner_state (singleton_id, owner_generation)
        VALUES (1, 'owner-current')
      `;
      const owners = yield* sql<{ readonly ownerGeneration: string }>`
        SELECT owner_generation AS "ownerGeneration" FROM server_owner_state
      `;
      assert.deepStrictEqual(owners, [{ ownerGeneration: "owner-current" }]);
    }),
  );
});
