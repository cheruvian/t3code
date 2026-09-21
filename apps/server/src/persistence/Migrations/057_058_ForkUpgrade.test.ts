import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.effect("adds title state and viewed files without changing the deployed fork ledger", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 56 });
    const before =
      yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
    const applied = yield* runMigrations();
    assert.deepEqual(applied, [
      [57, "ProjectionThreadTitleState"],
      [58, "PullRequestFilesViewed"],
    ]);
    const after =
      yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id <= 56 ORDER BY migration_id`;
    assert.deepEqual(after, before);
    const columns = yield* sql<{
      readonly name: string;
      readonly notnull: number;
    }>`PRAGMA table_info(projection_threads)`;
    assert.equal(columns.find((column) => column.name === "title_state_json")?.notnull, 0);
    yield* sql`INSERT INTO pull_request_files_viewed (provider, host, repository, number, viewer, path, revision, viewed_at)
      VALUES ('github', 'github.com', 'owner/repo', 1, 'reader', 'README.md', 'abc', '2026-09-17T00:00:00.000Z')`;
    assert.equal((yield* sql`SELECT * FROM pull_request_files_viewed`).length, 1);
    assert.deepEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(Layer.fresh(NodeSqliteClient.layer({ filename: ":memory:" })))),
);
