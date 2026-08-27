import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const migrationLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

migrationLayer("046_ProjectionProjectsDisabledGlobalScripts", (it) => {
  it.effect("adds a non-null empty-array default for existing projects", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 45 });
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('p', 'P', '/p', '[]', '2026-01-01', '2026-01-01')`;
      yield* runMigrations({ toMigrationInclusive: 46 });
      const rows = yield* sql<{
        readonly disabled: string;
      }>`SELECT disabled_inherited_script_ids_json AS disabled FROM projection_projects WHERE project_id = 'p'`;
      assert.deepStrictEqual(rows, [{ disabled: "[]" }]);
    }),
  );
});
