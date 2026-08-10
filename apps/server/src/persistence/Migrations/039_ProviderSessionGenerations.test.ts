import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("039_ProviderSessionGenerations", (it) => {
  it.effect("adds nullable generation ownership without claiming legacy sessions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 38 });
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          provider_instance_id,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at
        ) VALUES (
          'legacy-thread',
          'codex',
          'codex:default',
          'codex',
          'full-access',
          'running',
          '2026-08-10T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 39 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(provider_session_runtime)
      `;
      assert.ok(columns.some((column) => column.name === "owner_generation"));
      assert.ok(columns.some((column) => column.name === "session_generation"));
      assert.ok(columns.some((column) => column.name === "terminal_disposition"));

      const [legacy] = yield* sql<{
        readonly ownerGeneration: string | null;
        readonly sessionGeneration: string | null;
        readonly terminalDisposition: string | null;
      }>`
        SELECT
          owner_generation AS "ownerGeneration",
          session_generation AS "sessionGeneration",
          terminal_disposition AS "terminalDisposition"
        FROM provider_session_runtime
        WHERE thread_id = 'legacy-thread'
      `;
      assert.deepStrictEqual(legacy, {
        ownerGeneration: null,
        sessionGeneration: null,
        terminalDisposition: null,
      });
    }),
  );
});
