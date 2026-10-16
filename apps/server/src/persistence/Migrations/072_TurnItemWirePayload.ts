import { OrchestrationV2TurnItemJson as OrchestrationV2TurnItemJsonSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  projectTurnItemForWire,
  TURN_ITEM_WIRE_PAYLOAD_VERSION,
} from "../../orchestration-v2/WireProjection.ts";

const codec = Schema.fromJsonString(OrchestrationV2TurnItemJsonSchema);
const decode = Schema.decodeUnknownEffect(codec);
const encode = Schema.encodeEffect(codec);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE orchestration_v2_projection_turn_items ADD COLUMN payload_wire_json TEXT`;
  yield* sql`ALTER TABLE orchestration_v2_projection_turn_items ADD COLUMN payload_wire_version INTEGER`;
  // Bound memory during upgrades. Invalid historical rows retain the normal full-payload fallback.
  let after = 0;
  while (true) {
    const rows = yield* sql<{ rowid: number; payload_json: string }>`SELECT rowid, payload_json
      FROM orchestration_v2_projection_turn_items WHERE rowid > ${after} ORDER BY rowid LIMIT 32`;
    if (rows.length === 0) break;
    for (const row of rows) {
      const wire = yield* decode(row.payload_json).pipe(
        Effect.flatMap((item) => encode(projectTurnItemForWire(item))),
        Effect.catch(() => Effect.succeed(null)),
      );
      if (wire !== null) {
        yield* sql`UPDATE orchestration_v2_projection_turn_items SET
          payload_wire_json = ${wire.length < row.payload_json.length ? wire : null},
          payload_wire_version = ${TURN_ITEM_WIRE_PAYLOAD_VERSION} WHERE rowid = ${row.rowid}`;
      }
      after = row.rowid;
    }
  }
});
