import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import migration from "./072_TurnItemWirePayload.ts";
import { TURN_ITEM_WIRE_PAYLOAD_VERSION } from "../../orchestration-v2/WireProjection.ts";

it.effect(
  "backfills multiple batches without replacing full payloads and leaves malformed rows unstamped",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE orchestration_v2_projection_turn_items (payload_json TEXT NOT NULL)`;
      const base = {
        id: "item",
        threadId: "thread",
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: null,
        completedAt: null,
        updatedAt: "2026-10-15T00:00:00.000Z",
        type: "command_execution",
        input: "echo test",
        output: "large output ".repeat(10000),
      };
      const original = JSON.stringify(base);
      for (let i = 0; i < 35; i++)
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items (payload_json) VALUES (${original})`;
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items (payload_json) VALUES ('malformed')`;
      yield* migration;
      const rows = yield* sql<{
        payload_json: string;
        payload_wire_json: string | null;
        payload_wire_version: number | null;
      }>`SELECT * FROM orchestration_v2_projection_turn_items ORDER BY rowid`;
      assert.lengthOf(rows, 36);
      for (const row of rows.slice(0, 35)) {
        assert.equal(row.payload_json, original);
        assert.equal(row.payload_wire_version, TURN_ITEM_WIRE_PAYLOAD_VERSION);
        assert.isBelow(row.payload_wire_json!.length, 2000);
        assert.equal(JSON.parse(row.payload_wire_json!).outputOmitted, true);
      }
      assert.deepEqual(rows[35], {
        payload_json: "malformed",
        payload_wire_json: null,
        payload_wire_version: null,
      });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
