import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ACTIVITY_PAYLOAD_SLIM_VERSION,
  projectPayload,
} from "../../orchestration/ActivityPayloadProjection.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const bulkyPayload = {
  itemType: "command_execution",
  title: "pnpm test",
  data: { toolCallId: "call-1", command: "pnpm test", transcript: "x".repeat(5_000) },
};
const passThroughPayload = { usedTokens: 1_234, maxTokens: 200_000 };
const bulkyPayloadJson = JSON.stringify(bulkyPayload);
const passThroughPayloadJson = JSON.stringify(passThroughPayload);

layer("039_040_ProjectionThreadActivityPayloadSlim", (it) => {
  it.effect("adds the slim payload columns and backfills pre-existing rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 38 });
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
        )
        VALUES
          ('activity-bulky', 'thread-1', 'turn-1', 'tool', 'tool.completed', 'Ran a command',
           ${bulkyPayloadJson}, '2026-08-17T00:00:00.000Z'),
          ('activity-plain', 'thread-1', 'turn-1', 'info', 'context-window.updated', 'Context',
           ${passThroughPayloadJson}, '2026-08-17T00:00:01.000Z'),
          ('activity-broken', 'thread-1', 'turn-1', 'info', 'runtime.note', 'Broken',
           'not json', '2026-08-17T00:00:02.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 40 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_activities)
      `;
      const names = new Set(columns.map((column) => column.name));
      assert.ok(names.has("payload_slim_json"));
      assert.ok(names.has("payload_slim_version"));

      const rows = yield* sql<{
        readonly activityId: string;
        readonly slim: string | null;
        readonly version: number | null;
      }>`
        SELECT
          activity_id AS "activityId",
          payload_slim_json AS "slim",
          payload_slim_version AS "version"
        FROM projection_thread_activities
        ORDER BY activity_id ASC
      `;
      const byId = new Map(rows.map((row) => [row.activityId, row]));

      // Unparseable payloads cannot be slimmed, so they stay on the fallback.
      assert.equal(byId.get("activity-broken")?.version, null);
      // Nothing to slim: the read falls back to the identical payload_json.
      assert.equal(byId.get("activity-plain")?.slim, null);
      assert.equal(byId.get("activity-plain")?.version, ACTIVITY_PAYLOAD_SLIM_VERSION);
      assert.equal(
        byId.get("activity-bulky")?.slim,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify(projectPayload(bulkyPayload)),
      );
      assert.equal(byId.get("activity-bulky")?.version, ACTIVITY_PAYLOAD_SLIM_VERSION);
    }),
  );
});
