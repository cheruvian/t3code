/**
 * ReadOnlySqlClient - Second SQLite connection reserved for client-facing reads.
 *
 * The write client (`SqlClient.SqlClient`) owns exactly one connection guarded
 * by a single permit, and a transaction holds that permit for its whole
 * duration. A heavy read therefore stalls every write and every live-event
 * projection in the process. This tag exposes a second connection opened
 * `readonly` against the same WAL database so those reads run on their own
 * permit.
 *
 * Only genuinely read-only, client-facing queries belong here. Anything that
 * round-trips rows back through a write — the revert projector's
 * list/delete/upsert in particular — must stay on the write client so it reads
 * its own uncommitted state.
 *
 * @module ReadOnlySqlClient
 */
import * as Context from "effect/Context";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export class ReadOnlySqlClient extends Context.Service<ReadOnlySqlClient, SqlClient.SqlClient>()(
  "t3/persistence/Services/ReadOnlySqlClient",
) {}
