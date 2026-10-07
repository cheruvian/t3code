import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationEntries, migrationManifest, runMigrations } from "./Migrations.ts";

// These are the published upstream ids, deliberately independent of the fork ledger.
const upstreamForkIds = [
  45, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 60, 61, 62, 64, 65, 66,
];
const seedUpstream = (variant: "main" | "preview53" | "preview54" | "preview54Indexes") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const entries = [
      ...migrationEntries.filter(([id]) => id <= 40),
      ...upstreamForkIds.map((forkId, index) => {
        const [, name, migration] = migrationEntries.find(([id]) => id === forkId)!;
        return [index + 41, name, migration] as const;
      }),
    ];
    const selected =
      variant === "main"
        ? entries
        : entries.filter(([id]) => id <= (variant === "preview53" ? 52 : 53));
    if (variant !== "main") {
      selected.push([
        variant === "preview53" ? 53 : 54,
        "OrchestrationV2",
        migrationEntries[60]![2],
      ]);
      if (variant === "preview54Indexes")
        selected.push([55, "RemoveRedundantProjectionIndexes", migrationEntries[61]![2]]);
    }
    yield* Migrator.make({})({
      loader: Migrator.fromRecord(
        Object.fromEntries(selected.map(([id, name, migration]) => [`${id}_${name}`, migration])),
      ),
    });
    yield* sql`INSERT INTO orchestration_v2_legacy_imports
    (thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count)
    VALUES ('preview-thread', '2026-09-15', '2026-09-15', '2026-09-16', 42)`;
    yield* sql`UPDATE effect_sql_migrations SET created_at = '2026-09-15 00:00:00' WHERE name = 'OrchestrationV2'`;
  });

describe("upstream ledger upgrades", () => {
  it.effect.each(["main", "preview53", "preview54", "preview54Indexes"] as const)(
    "preserves V2 schema and import progress from %s",
    (variant) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedUpstream(variant);
        const imports = yield* sql`SELECT * FROM orchestration_v2_legacy_imports`;
        const executed = yield* runMigrations();
        assert.ok(executed.some(([id]) => id === 59));
        assert.ok(!executed.some(([id]) => id === 61));
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_v2_legacy_imports`, imports);
        const history = yield* sql<{
          migration_id: number;
          name: string;
        }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
        assert.deepStrictEqual(
          history.map((row) => [row.migration_id, row.name] as const),
          migrationManifest,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 61`,
          [{ created_at: "2026-09-15 00:00:00" }],
        );
        const projectColumns = yield* sql<{ name: string }>`PRAGMA table_info(projection_projects)`;
        assert.ok(projectColumns.some((column) => column.name === "resource_locks_json"));
        assert.ok(
          projectColumns.some((column) => column.name === "disabled_inherited_script_ids_json"),
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rolls back schema and ledger together on failure and can retry", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedUpstream("preview53");
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      yield* sql`CREATE TRIGGER fail_preview_upgrade BEFORE INSERT ON effect_sql_migrations
      WHEN NEW.name = 'PullRequestFilesViewed' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'pull_request_files_viewed'`,
        [],
      );
      assert.strictEqual((yield* sql`SELECT * FROM orchestration_v2_legacy_imports`).length, 1);
      yield* sql`DROP TRIGGER fail_preview_upgrade`;
      yield* runMigrations();
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses unknown history before modifying schema or ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedUpstream("preview53");
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (54, 'UnknownFork')`;
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
