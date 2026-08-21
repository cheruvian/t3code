import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { runMigrations } from "../Migrations.ts";
import { ReadOnlySqlClient } from "../Services/ReadOnlySqlClient.ts";
import { ServerConfig } from "../../config.ts";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
  readonly readonly?: boolean;
  readonly disableWAL?: boolean;
  readonly spanAttributes?: Record<string, unknown>;
};

type Loader = {
  layer: (config: RuntimeSqliteLayerConfig) => Layer.Layer<SqlClient.SqlClient, SqlError>;
};
const defaultSqliteClientLoaders = {
  bun: () => import("@effect/sql-sqlite-bun/SqliteClient"),
  node: () => import("../NodeSqliteClient.ts"),
} satisfies Record<string, () => Promise<Loader>>;

const makeRuntimeSqliteLayer = Effect.fn("makeRuntimeSqliteLayer")(function* (
  config: RuntimeSqliteLayerConfig,
) {
  const runtime = process.versions.bun !== undefined ? "bun" : "node";
  const loader = defaultSqliteClientLoaders[runtime];
  const clientModule = yield* Effect.promise<Loader>(loader);
  return clientModule.layer(config);
}, Layer.unwrap);

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* runMigrations();
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
  makeRuntimeSqliteLayer({
    ...config,
    readonly: true,
    // Journal mode is a property of the database file, already set to WAL by
    // `setup` on the write connection; a read-only connection can neither set
    // nor need to set it.
    disableWAL: true,
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
        : readOnlyConnectionLayer(config);
    }),
  );

export const makeSqlitePersistenceLive = Effect.fn("makeSqlitePersistenceLive")(function* (
  dbPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  const config = {
    filename: dbPath,
    spanAttributes: {
      "db.name": path.basename(dbPath),
      "service.name": "t3-server",
    },
  } satisfies RuntimeSqliteLayerConfig;

  return Layer.provideMerge(
    readOnlySqlClientLayer(config),
    Layer.provideMerge(setup, makeRuntimeSqliteLayer(config)),
  );
}, Layer.unwrap);

export const SqlitePersistenceMemory = Layer.provideMerge(
  readOnlySqlClientLayer({ filename: ":memory:" }),
  Layer.provideMerge(setup, makeRuntimeSqliteLayer({ filename: ":memory:" })),
);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    return makeSqlitePersistenceLive(dbPath);
  }),
);
