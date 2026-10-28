// @effect-diagnostics nodeBuiltinImport:off - Names a temp database path before any layer exists.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { ReadOnlySqlClient } from "./Services/ReadOnlySqlClient.ts";
import { layerFromPath, layerMemory } from "./Sqlite.ts";

const makeFilePersistenceLayer = () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-readonly-sql-"));
  // Nested, non-existent directory: a fresh install has to create the tree,
  // the file, and the schema before the read-only connection can open.
  const dbPath = NodePath.join(tempDir, "state", "orchestration.sqlite");
  return {
    dbPath,
    layer: layerFromPath(dbPath).pipe(Layer.provideMerge(NodeServices.layer)),
  };
};

const countReceipts = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly total: number;
  }>`SELECT COUNT(*) AS "total" FROM orchestration_v2_command_receipts`.pipe(
    Effect.map((rows) => rows[0]?.total ?? -1),
  );

const insertReceipt = (sql: SqlClient.SqlClient, projector: string) =>
  sql`
    INSERT INTO orchestration_v2_command_receipts (command_id, thread_id, command_type, accepted_at, result_sequence, status)
    VALUES (${projector}, 'test-thread', 'test-command', '2024-01-01T00:00:00.000Z', 1, 'accepted')
  `;

// Gives every runnable fiber repeated turns on the scheduler. Everything the
// SQLite clients do is synchronous once a permit is held, so a fiber that has
// not finished after this many turns is parked on a permit, not merely slow.
const drainScheduler = Effect.replicateEffect(Effect.yieldNow, 100, { discard: true });

it.effect("aliases the write client for in-memory databases", () =>
  Effect.gen(function* () {
    const writeSql = yield* SqlClient.SqlClient;
    const readSql = yield* ReadOnlySqlClient;

    // A second connection to `:memory:` would be a different, empty database,
    // so the read client has to be the write client itself.
    assert.strictEqual(readSql, writeSql);

    yield* insertReceipt(writeSql, "memory-alias");
    assert.equal(yield* countReceipts(readSql), 1);
  }).pipe(Effect.provide(layerMemory)),
);

it.effect("opens a distinct read-only connection on a freshly created database", () => {
  const { dbPath, layer } = makeFilePersistenceLayer();
  return Effect.gen(function* () {
    const writeSql = yield* SqlClient.SqlClient;
    const readSql = yield* ReadOnlySqlClient;

    assert.notStrictEqual(readSql, writeSql);
    assert.isTrue(NodeFS.existsSync(dbPath));

    // Reads a table that only exists because migrations ran on the write
    // connection first: the read connection cannot create or migrate one.
    assert.equal(yield* countReceipts(readSql), 0);

    yield* insertReceipt(writeSql, "fresh-install");
    assert.equal(yield* countReceipts(readSql), 1);
  }).pipe(Effect.provide(layer));
});

it.effect("refuses writes on the read connection", () => {
  const { layer } = makeFilePersistenceLayer();
  return Effect.gen(function* () {
    const readSql = yield* ReadOnlySqlClient;
    const error = yield* Effect.flip(insertReceipt(readSql, "rejected"));
    assert.include(String(error.reason.cause), "readonly database");
  }).pipe(Effect.provide(layer));
});

it.effect("lets a write commit while a read transaction is open", () => {
  const { layer } = makeFilePersistenceLayer();
  return Effect.gen(function* () {
    const writeSql = yield* SqlClient.SqlClient;
    const readSql = yield* ReadOnlySqlClient;

    const readOpened = yield* Deferred.make<void>();
    const releaseRead = yield* Deferred.make<void>();
    const writeCommitted = yield* Deferred.make<void>();

    const readFiber = yield* readSql
      .withTransaction(
        Effect.gen(function* () {
          yield* countReceipts(readSql);
          yield* Deferred.succeed(readOpened, undefined);
          yield* Deferred.await(releaseRead);
        }),
      )
      .pipe(Effect.forkChild);

    yield* Deferred.await(readOpened);

    const writeFiber = yield* insertReceipt(writeSql, "concurrent-write").pipe(
      Effect.andThen(Deferred.succeed(writeCommitted, undefined)),
      Effect.forkChild,
    );

    yield* drainScheduler;
    // The whole point of the second connection: this is false today, because
    // the read transaction holds the process-wide permit until it commits.
    assert.isTrue(yield* Deferred.isDone(writeCommitted), "write blocked by open read transaction");

    yield* Deferred.succeed(releaseRead, undefined);
    yield* Fiber.join(readFiber);
    yield* Fiber.join(writeFiber);

    assert.equal(yield* countReceipts(writeSql), 1);
  }).pipe(Effect.provide(layer));
});

it.effect("blocks the same write behind a read transaction on the write connection", () => {
  const { layer } = makeFilePersistenceLayer();
  return Effect.gen(function* () {
    // Control for the test above: identical shape, read transaction on the
    // write client. This is what every client-facing read did before the read
    // connection existed.
    const writeSql = yield* SqlClient.SqlClient;

    const readOpened = yield* Deferred.make<void>();
    const releaseRead = yield* Deferred.make<void>();
    const writeCommitted = yield* Deferred.make<void>();

    const readFiber = yield* writeSql
      .withTransaction(
        Effect.gen(function* () {
          yield* countReceipts(writeSql);
          yield* Deferred.succeed(readOpened, undefined);
          yield* Deferred.await(releaseRead);
        }),
      )
      .pipe(Effect.forkChild);

    yield* Deferred.await(readOpened);

    const writeFiber = yield* insertReceipt(writeSql, "serialized-write").pipe(
      Effect.andThen(Deferred.succeed(writeCommitted, undefined)),
      Effect.forkChild,
    );

    yield* drainScheduler;
    assert.isFalse(
      yield* Deferred.isDone(writeCommitted),
      "write should be parked on the write connection's permit",
    );

    yield* Deferred.succeed(releaseRead, undefined);
    yield* Fiber.join(readFiber);
    yield* Fiber.join(writeFiber);

    assert.equal(yield* countReceipts(writeSql), 1);
  }).pipe(Effect.provide(layer));
});

it.effect("never reads ahead of the write connection inside a read transaction", () => {
  const { layer } = makeFilePersistenceLayer();
  return Effect.gen(function* () {
    const writeSql = yield* SqlClient.SqlClient;
    const readSql = yield* ReadOnlySqlClient;

    yield* insertReceipt(writeSql, "before-read");

    const readOpened = yield* Deferred.make<void>();
    const writeCommitted = yield* Deferred.make<void>();
    const observed: Array<number> = [];

    const readFiber = yield* readSql
      .withTransaction(
        Effect.gen(function* () {
          observed.push(yield* countReceipts(readSql));
          yield* Deferred.succeed(readOpened, undefined);
          yield* Deferred.await(writeCommitted);
          // Same transaction, after a concurrent commit: the WAL snapshot is
          // pinned at BEGIN, so the row committed since is invisible. A read
          // that could see it would let `getThreadDetailSnapshot` return a
          // sequence ahead of its rows and make the client drop events.
          observed.push(yield* countReceipts(readSql));
        }),
      )
      .pipe(Effect.forkChild);

    yield* Deferred.await(readOpened);
    yield* insertReceipt(writeSql, "during-read");
    yield* Deferred.succeed(writeCommitted, undefined);
    yield* Fiber.join(readFiber);

    assert.deepEqual(observed, [1, 1]);
    // Once the transaction closes, the read connection catches up; it lags,
    // it never leads.
    assert.equal(yield* countReceipts(readSql), 2);
    assert.equal(yield* countReceipts(writeSql), 2);
  }).pipe(Effect.provide(layer));
});

it.effect("nests write-client transactions inside a read-client transaction", () => {
  const { layer } = makeFilePersistenceLayer();
  return Effect.gen(function* () {
    const writeSql = yield* SqlClient.SqlClient;
    const readSql = yield* ReadOnlySqlClient;
    yield* insertReceipt(writeSql, "nested-read");
    const count = yield* readSql.withTransaction(
      writeSql.withTransaction(readSql.withTransaction(countReceipts(writeSql))),
    );
    assert.equal(count, 1);
  }).pipe(Effect.provide(layer));
});
