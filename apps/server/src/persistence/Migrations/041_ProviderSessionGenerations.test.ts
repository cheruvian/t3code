import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_ProviderSessionGenerations", (it) => {
  it.effect("adds nullable generation ownership without claiming legacy sessions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
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

      yield* runMigrations({ toMigrationInclusive: 41 });

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

it.effect("repairs databases that recorded the generation migration under id 39", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 38 });
    yield* sql`
      ALTER TABLE provider_session_runtime ADD COLUMN owner_generation TEXT
    `;
    yield* sql`
      ALTER TABLE provider_session_runtime ADD COLUMN session_generation TEXT
    `;
    yield* sql`
      ALTER TABLE provider_session_runtime ADD COLUMN terminal_disposition TEXT
    `;
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
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name, created_at)
      VALUES
        (39, 'ProviderSessionGenerations', datetime('now')),
        (40, 'ServerDrainState', datetime('now'))
    `;

    yield* runMigrations({ toMigrationInclusive: 42 });

    const projectColumns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(projection_projects)
    `;
    assert.ok(projectColumns.some((column) => column.name === "default_thread_env_mode"));
    assert.ok(projectColumns.some((column) => column.name === "favicon_path"));
    const runtimeColumns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(provider_session_runtime)
    `;
    assert.equal(runtimeColumns.filter((column) => column.name === "session_generation").length, 1);
    const drainTables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('server_drain_state', 'server_owner_state')
    `;
    assert.equal(drainTables.length, 2);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
