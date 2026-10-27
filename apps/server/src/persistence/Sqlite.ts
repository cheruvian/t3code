import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "./Migrations.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import * as ServerConfig from "../config.ts";
import { ReadOnlySqlClient } from "./Services/ReadOnlySqlClient.ts";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
  readonly readonly?: boolean;
  readonly readerWorker?: boolean;
  readonly checkpointWorker?: boolean;
  readonly spanAttributes?: Record<string, unknown>;
  readonly transactionClient?: SqlClient.SqlClient;
};
// Size the -wal file is cut back to on the first commit after a WAL reset.
export const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

const layerSetup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    // Existing databases need doctor's offline VACUUM to add pointer maps for this mode.
    const tables = yield* sql<{
      readonly count: number;
    }>`SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table'`;
    if (tables[0]?.count === 0) yield* sql`PRAGMA auto_vacuum = INCREMENTAL;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    // FULL fsyncs every event commit on the main thread; NORMAL syncs only at WAL checkpoints.
    // App crashes lose nothing; OS crashes or power loss can roll back post-checkpoint commits without corruption.
    yield* sql`PRAGMA synchronous = NORMAL;`;
    // macOS fsync misses drive caches; F_FULLFSYNC flushes them at checkpoints and is ignored elsewhere.
    yield* sql`PRAGMA checkpoint_fullfsync = ON;`;
    // PASSIVE checkpoints retain peak WAL size until the last connection closes.
    yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
    yield* runMigrations();
    // Collecting stats scans every page, and stale small-table stats cause scans after growth; use indexes by default.
    // Connections cache stats; reload after deleting them.
    const statTables = yield* sql`SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_stat1'`;
    if (statTables.length > 0) {
      yield* sql`DELETE FROM sqlite_stat1;`;
      yield* sql`ANALYZE sqlite_schema;`;
    }
  }),
);

/**
 * `:memory:` and its URI spellings name a database private to one connection:
 * opening a second connection on the same name yields a different, empty
 * database rather than the first one's contents. Tests run on these, so the
 * read client aliases the write client there instead of opening anything.
 */
const isInMemoryDatabase = (filename: string): boolean =>
  filename === "" ||
  filename === ":memory:" ||
  filename.startsWith("file::memory:") ||
  /[?&]mode=memory(?:&|$)/.test(filename);

const readOnlyConnectionLayer = (config: RuntimeSqliteLayerConfig) =>
  NodeSqliteClient.layer({
    ...config,
    readonly: true,
    readerWorker: true,
    spanAttributes: { ...config.spanAttributes, "db.connection.role": "read" },
  }).pipe(
    Layer.flatMap((context) => {
      const client = Context.get(context, SqlClient.SqlClient);
      return Layer.effect(
        ReadOnlySqlClient,
        // Two connections on one file can now briefly contend (a reader
        // arriving while the writer rewrites the WAL index, an auto-checkpoint
        // racing a reader). SQLite's default is to fail such a wait
        // immediately; wait instead.
        Effect.as(client`PRAGMA busy_timeout = 5000;`, client),
      );
    }),
  );

/**
 * Read connection layer. It depends on the write client, which is what orders
 * it after `setup`: migrations create and upgrade the file on the write
 * connection, and a read-only connection can do neither — opening one against
 * a missing or unmigrated database fails.
 */
const readOnlySqlClientLayer = (config: RuntimeSqliteLayerConfig) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const writeClient = yield* SqlClient.SqlClient;
      return isInMemoryDatabase(config.filename)
        ? Layer.succeed(ReadOnlySqlClient, writeClient)
        : readOnlyConnectionLayer({ ...config, transactionClient: writeClient });
    }),
  );

export const layerFromPath = Effect.fn("layerFromPath")(function* (dbPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  const config = {
    filename: dbPath,
    readerWorker: true,
    checkpointWorker: true,
    spanAttributes: {
      "db.name": path.basename(dbPath),
      "service.name": "t3-server",
    },
  } satisfies RuntimeSqliteLayerConfig;

  return Layer.provideMerge(
    readOnlySqlClientLayer(config),
    Layer.provideMerge(layerSetup, NodeSqliteClient.layer(config)),
  );
}, Layer.unwrap);

export const layerMemory = Layer.provideMerge(
  readOnlySqlClientLayer({ filename: ":memory:" }),
  Layer.provideMerge(layerSetup, NodeSqliteClient.layer({ filename: ":memory:" })),
);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    yield* initializeV2Database(dbPath);
    return layerFromPath(dbPath);
  }),
);
