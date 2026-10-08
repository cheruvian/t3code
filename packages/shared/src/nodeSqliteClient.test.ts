import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";

import * as SqliteClient from "./nodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layer({ filename: ":memory:" }));

layer("NodeSqliteClient", (it) => {
  it.effect("retries preparing a query after the missing schema becomes available", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const select = sql<{ name: string }>`SELECT name FROM created_after_prepare_failure`;
      const error = yield* select.pipe(Effect.flip);
      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");

      yield* sql`CREATE TABLE created_after_prepare_failure(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO created_after_prepare_failure VALUES ('recovered')`;
      assert.deepEqual(yield* select, [{ name: "recovered" }]);
      assert.deepEqual(yield* select.values, [["recovered"]]);
    }),
  );

  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");

      const unpreparedValues = yield* sql`SELECT id, name FROM entries ORDER BY id`
        .valuesUnprepared;
      assert.deepEqual(unpreparedValues, values);
    }),
  );

  it.effect("returns a typed failure when an unprepared statement cannot be prepared", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const error = yield* Effect.flip(sql.unsafe("SELECT FROM").unprepared);

      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");
    }),
  );

  it.effect("classifies constraint failures by their SQLite result code", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE constrained(name TEXT NOT NULL UNIQUE)`;
      yield* sql`INSERT INTO constrained VALUES ('taken')`;

      const duplicate = yield* sql`INSERT INTO constrained VALUES ('taken')`.pipe(Effect.flip);
      assert(duplicate.reason._tag === "UniqueViolation");
      assert.equal(duplicate.reason.constraint, "constrained.name");

      const missing = yield* sql`INSERT INTO constrained VALUES (NULL)`.pipe(Effect.flip);
      assert.equal(missing.reason._tag, "ConstraintError");
    }),
  );
});

const makeTempDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-transaction-" });
  const filename = path.join(directory, "state.sqlite");
  // node:sqlite connections fail a busy statement at once unless given a timeout.
  const other = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
    (database) => Effect.sync(() => database.close()),
  );
  yield* Effect.sync(() => {
    other.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE counters(id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO counters VALUES (1, 0);
    `);
  });
  return { filename, other };
});

it.effect("keeps the event loop responsive while a file-backed query executes", () =>
  Effect.gen(function* () {
    const { filename } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const completed: string[] = [];
      const query = yield* sql`
        WITH RECURSIVE numbers(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 1000000
        ) SELECT SUM(value) AS total FROM numbers
      `.pipe(
        Effect.tap(() => Effect.sync(() => completed.push("query"))),
        Effect.forkChild,
      );
      yield* Effect.callback<void>((resume) => {
        setImmediate(() =>
          resume(
            Effect.sync(() => {
              completed.push("heartbeat");
            }),
          ),
        );
      });
      assert.deepEqual(completed, ["heartbeat"]);
      assert.deepEqual(yield* Fiber.join(query), [{ total: 500000500000 }]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps another connection from committing between a transaction's read and write", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{ readonly value: number }>`
            SELECT value FROM counters WHERE id = 1
          `;
          // With a deferred BEGIN this commit lands and the write below fails
          // with SQLITE_BUSY_SNAPSHOT, which no busy timeout can wait out.
          yield* Effect.sync(() =>
            assert.throws(
              () => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"),
              /database is locked/,
            ),
          );
          yield* sql`UPDATE counters SET value = ${(row?.value ?? 0) + 10} WHERE id = 1`;
        }),
      );
      yield* Effect.sync(() => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"));
      assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`.values, [[11]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "rolls back nested transactions and preserves blobs and safe integers across the worker",
  () =>
    Effect.gen(function* () {
      const { filename } = yield* makeTempDatabase;
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE counters SET value = 10 WHERE id = 1`;
            yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql`UPDATE counters SET value = 99 WHERE id = 1`;
                  return yield* Effect.fail("undo nested write");
                }),
              )
              .pipe(Effect.flip);
            assert.deepEqual(yield* sql`SELECT value FROM counters`.valuesUnprepared, [[10]]);
          }),
        );
        assert.deepEqual(yield* sql`SELECT value FROM counters`.values, [[10]]);
        const blob = new Uint8Array([0, 1, 127, 255]);
        assert.deepEqual(yield* sql`SELECT ${blob} AS bytes`.unprepared, [{ bytes: blob }]);
        assert.deepEqual(
          yield* sql`SELECT 9007199254740993 AS value`.pipe(
            Effect.provideService(SqlClient.SafeIntegers, true),
          ),
          [{ value: 9007199254740993n }],
        );
        yield* sql`CREATE TABLE unique_values(value TEXT UNIQUE)`;
        yield* sql`INSERT INTO unique_values VALUES ('taken')`;
        const duplicate = yield* sql`INSERT INTO unique_values VALUES ('taken')`.pipe(Effect.flip);
        assert.equal(duplicate.reason._tag, "UniqueViolation");
      }).pipe(Effect.provide(SqliteClient.layer({ filename })));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rolls back a cancelled worker transaction before the connection is reused", () =>
  Effect.gen(function* () {
    const { filename } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const written = yield* Deferred.make<void>();
      const transaction = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE counters SET value = 99 WHERE id = 1`;
            yield* Deferred.succeed(written, undefined);
            return yield* Effect.never;
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(written);
      yield* Fiber.interrupt(transaction);
      assert.deepEqual(yield* sql`SELECT value FROM counters`.values, [[0]]);
      yield* sql.withTransaction(sql`UPDATE counters SET value = 10 WHERE id = 1`);
      assert.deepEqual(yield* sql`SELECT value FROM counters`.values, [[10]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports a transaction blocked by another writer as a lock timeout", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 0`;
      const read = sql.withTransaction(sql`SELECT value FROM counters WHERE id = 1`.values);

      yield* Effect.sync(() => other.exec("BEGIN IMMEDIATE"));
      const error = yield* read.pipe(Effect.flip);
      assert.equal(error.reason._tag, "LockTimeoutError");

      yield* Effect.sync(() => other.exec("COMMIT"));
      assert.deepEqual(yield* read, [[0]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns a typed failure when the database cannot be opened", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Layer.build(SqliteClient.layer({ filename: "\0" })).pipe(Effect.scoped),
    );

    assert.equal(error._tag, "SqlError");
    assert.equal(error.reason.operation, "open");
  }),
);

it.effect(
  "recovers a prepared query immediately after an exclusive database lock is released",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-prepare-" });
      const filename = path.join(directory, "state.sqlite");
      const blocker = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
        (database) => Effect.sync(() => database.close()),
      );
      yield* Effect.sync(() => {
        blocker.exec("CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('retained')");
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.sync(() => blocker.exec("BEGIN EXCLUSIVE"));
        const select = sql`SELECT value FROM entries`;
        const error = yield* select.values.pipe(Effect.flip);
        assert.equal(error._tag, "SqlError");
        assert.equal(error.reason.operation, "prepare");
        yield* Effect.sync(() => blocker.exec("ROLLBACK"));
        assert.deepEqual(yield* select.values, [["retained"]]);
        assert.deepEqual(yield* select, [{ value: "retained" }]);
      }).pipe(Effect.provide(SqliteClient.layer({ filename })));
    }).pipe(Effect.provide(NodeServices.layer)),
);
