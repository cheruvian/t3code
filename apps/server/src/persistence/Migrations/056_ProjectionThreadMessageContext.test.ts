import { assert, it, describe } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

describe("056_ProjectionThreadMessageContext", () => {
  it.effect("upgrades the fork ledger without reassigning applied migration identities", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      const before =
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
      const beforeColumns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(projection_thread_messages)`;
      assert.isFalse(beforeColumns.some((column) => column.name === "context_json"));

      const applied = yield* runMigrations({ toMigrationInclusive: 56 });
      assert.deepEqual(applied, [[56, "ProjectionThreadMessageContext"]]);
      const after =
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id <= 55 ORDER BY migration_id`;
      assert.deepEqual(after, before);
      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
      }>`PRAGMA table_info(projection_thread_messages)`;
      assert.equal(columns.find((column) => column.name === "context_json")?.notnull, 0);
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 56 }), []);
    }).pipe(Effect.provide(Layer.fresh(NodeSqliteClient.layer({ filename: ":memory:" })))),
  );

  it.effect("accepts context added by an earlier development migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`
        ALTER TABLE projection_thread_messages
        ADD COLUMN context_json TEXT
      `;

      yield* runMigrations({ toMigrationInclusive: 56 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      const context = columns.find((column) => column.name === "context_json");
      const migrations = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id
        FROM effect_sql_migrations
        WHERE migration_id = 56
      `;

      assert.equal(context?.name, "context_json");
      assert.equal(context?.notnull, 0);
      assert.equal(migrations.length, 1);
    }).pipe(Effect.provide(Layer.fresh(NodeSqliteClient.layer({ filename: ":memory:" })))),
  );
});
