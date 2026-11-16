/**
 * Independent read-only WAL connection and permit for client-facing queries.
 * Inside a write transaction, reads share the writer connection.
 * Read-modify-write operations must start on the write client.
 */
import * as Context from "effect/Context";
import type * as SqlClient from "effect/sql/SqlClient";

export class ReadOnlySqlClient extends Context.Service<ReadOnlySqlClient, SqlClient.SqlClient>()(
  "t3/persistence/Services/ReadOnlySqlClient",
) {}
