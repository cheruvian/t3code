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
 * Only genuinely read-only queries belong here. Read-modify-write operations
 * must begin their transaction on the write client.
 * Both clients share a transaction context, so a read called inside a write
 * transaction uses the writer's connection. Outside a transaction, reads use
 * the independent read-only connection and permit.
 *
 * @module ReadOnlySqlClient
 */
import * as Context from "effect/Context";
import type * as SqlClient from "effect/sql/SqlClient";

export class ReadOnlySqlClient extends Context.Service<ReadOnlySqlClient, SqlClient.SqlClient>()(
  "t3/persistence/Services/ReadOnlySqlClient",
) {}
