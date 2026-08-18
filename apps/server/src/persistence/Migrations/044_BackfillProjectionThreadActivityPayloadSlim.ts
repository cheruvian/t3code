import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ACTIVITY_PAYLOAD_SLIM_VERSION,
  projectPayload,
} from "../../orchestration/ActivityPayloadProjection.ts";

/**
 * Rows per pass. Bounds how many payloads are held in memory at once, and
 * batches the writes: one commit per row instead of per chunk turns a two
 * second backfill of a 54k-row database into a forty-six second one.
 */
const CHUNK_SIZE = 500;

/**
 * Fills the slim payload column for rows that predate it, so existing threads
 * open as cheaply as new ones instead of waiting to be rewritten. Purely an
 * optimization: reads fall back to `payload_json` for anything this leaves
 * unstamped, so an interrupted or partial run is correct, just slower. Resumes
 * from where it stopped because it only visits rows with no version stamp.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  let afterRowId = 0;
  for (;;) {
    const rows = yield* sql<{
      readonly rowid: number;
      readonly activityId: string;
      readonly payloadJson: string;
    }>`
      SELECT
        rowid,
        activity_id AS "activityId",
        payload_json AS "payloadJson"
      FROM projection_thread_activities
      WHERE rowid > ${afterRowId}
        AND payload_slim_version IS NULL
      ORDER BY rowid ASC
      LIMIT ${CHUNK_SIZE}
    `;
    if (rows.length === 0) {
      return;
    }
    afterRowId = rows[rows.length - 1]!.rowid;

    yield* sql.withTransaction(
      Effect.forEach(
        rows,
        (row) => {
          // A payload that will not parse cannot be slimmed; stamping it
          // anyway would make reads serve the unusable value, so leave it for
          // the fallback path.
          let payload: unknown;
          try {
            payload = JSON.parse(row.payloadJson) as unknown;
          } catch {
            return Effect.void;
          }
          const slim = projectPayload(payload);
          return sql`
            UPDATE projection_thread_activities
            SET payload_slim_json = ${slim === payload ? null : JSON.stringify(slim)},
                payload_slim_version = ${ACTIVITY_PAYLOAD_SLIM_VERSION}
            WHERE activity_id = ${row.activityId}
          `;
        },
        { concurrency: 1, discard: true },
      ),
    );
  }
});
