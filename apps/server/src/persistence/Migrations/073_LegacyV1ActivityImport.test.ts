import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.effect(
  "marks completed V1 transcript imports for activity backfill without changing their ledger",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 72 });
      const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      yield* sql`INSERT INTO orchestration_v2_legacy_imports
      (thread_id,source_updated_at,shell_imported_at,transcript_imported_at,imported_message_count)
      VALUES ('old','2026-01-01','2026-01-01','2026-01-02',5)`;
      assert.deepEqual(yield* runMigrations(), [[73, "LegacyV1ActivityImport"]]);
      assert.deepEqual(
        yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <=72 ORDER BY migration_id`,
        ledger,
      );
      const rows =
        yield* sql`SELECT transcript_imported_at,activity_imported_at,imported_message_count
      FROM orchestration_v2_legacy_imports WHERE thread_id='old'`;
      assert.deepEqual(rows, [
        {
          transcript_imported_at: "2026-01-02",
          activity_imported_at: null,
          imported_message_count: 5,
        },
      ]);
      assert.deepEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(Layer.fresh(NodeSqliteClient.layer({ filename: ":memory:" })))),
);
