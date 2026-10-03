import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("055_OrchestrationV2", (it) => {
  it.effect("keeps released migrations contiguous", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        migrationEntries.map(([id]) => id),
        Array.from({ length: 62 }, (_, index) => index + 1),
      );
    }),
  );

  it.effect("upgrades fork schema 60 without changing its ledger or resource reservations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });

      const before =
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at, resource_locks_json)
        VALUES ('resource-owner', 'Resource owner', '/tmp/resource-owner', NULL, '[]', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z', '[{"threadId":"owner","phase":"held"}]')`;
      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [
        [61, "OrchestrationV2"],
        [62, "RemoveRedundantProjectionIndexes"],
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);

      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id <= 60 ORDER BY migration_id`,
        before,
      );
      const projects = yield* sql<{
        readonly resource_locks_json: string;
      }>`SELECT resource_locks_json FROM projection_projects WHERE project_id = 'resource-owner'`;
      assert.equal(projects[0]?.resource_locks_json, '[{"threadId":"owner","phase":"held"}]');

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'orchestration_v2_projection_threads',
            'orchestration_v2_projection_subagents',
            'orchestration_v2_effect_outbox',
            'orchestration_v2_turn_item_positions',
            'orchestration_v2_projection_metadata',
            'orchestration_v2_projection_provider_session_bindings',
            'orchestration_v2_thread_launch_workflows',
            'orchestration_v2_legacy_imports',
            'scheduled_tasks'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map(({ name }) => name),
        [
          "orchestration_v2_effect_outbox",
          "orchestration_v2_legacy_imports",
          "orchestration_v2_projection_metadata",
          "orchestration_v2_projection_provider_session_bindings",
          "orchestration_v2_projection_subagents",
          "orchestration_v2_projection_threads",
          "orchestration_v2_thread_launch_workflows",
          "orchestration_v2_turn_item_positions",
          "scheduled_tasks",
        ],
      );

      const eventColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_events)
      `;
      const receiptColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_command_receipts)
      `;
      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_projection_threads)
      `;
      const subagentColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_projection_subagents)
      `;
      assert.ok(eventColumns.some(({ name }) => name === "application_event_version"));
      assert.ok(receiptColumns.some(({ name }) => name === "command_type"));
      assert.ok(threadColumns.some(({ name }) => name === "provider_instance_id"));
      assert.ok(subagentColumns.some(({ name }) => name === "driver"));
      assert.ok(subagentColumns.some(({ name }) => name === "provider_instance_id"));

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'idx_orchestration_events_application_high_water',
            'orchestration_events_v2_created_threads_idx',
            'orchestration_v2_projection_turn_items_shell_pending_idx'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        indexes.map(({ name }) => name),
        [
          "idx_orchestration_events_application_high_water",
          "orchestration_events_v2_created_threads_idx",
          "orchestration_v2_projection_turn_items_shell_pending_idx",
        ],
      );
    }),
  );
});
