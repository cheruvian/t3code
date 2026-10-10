import * as NodeWorkerThreads from "node:worker_threads";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Client from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";

import type { SqliteClientConfig } from "./nodeSqliteClient.ts";

interface WorkerCommand {
  readonly id: number;
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
  readonly prepared: boolean;
  readonly values: boolean;
  readonly raw: boolean;
  readonly safeIntegers: boolean;
  readonly now: number;
  readonly close?: boolean;
}

interface WorkerFailure {
  readonly message: string;
  readonly code?: string;
  readonly errcode?: number;
  readonly operation: string;
}

interface WorkerResponse {
  readonly id: number;
  readonly result?: ReadonlyArray<unknown>;
  readonly error?: WorkerFailure;
}

// This function is serialized into the bundle's worker. Built-ins are resolved
// inside it so it also works in Electron and single-executable distributions.
function runSqliteWorker() {
  const { parentPort, workerData } = process.getBuiltinModule(
    "node:worker_threads",
  ) as typeof import("node:worker_threads");
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const port = parentPort!;
  const options = workerData as {
    filename: string;
    readonly?: boolean;
    allowExtension?: boolean;
    capacity: number;
    ttl: number;
  };
  const failure = (id: number, operation: string, cause: unknown) => {
    const error = cause as Partial<Error & { code: string; errcode: number }> | null;
    port.postMessage({
      id,
      error: {
        operation,
        message: error?.message ?? "SQLite worker failed.",
        code: error?.code,
        errcode: error?.errcode,
      },
    });
  };
  let database: import("node:sqlite").DatabaseSync;
  try {
    database = new DatabaseSync(options.filename, {
      readOnly: options.readonly ?? false,
      allowExtension: options.allowExtension ?? false,
    });
  } catch (cause) {
    failure(0, "open", cause);
    port.close();
    return;
  }
  const cache = new Map<
    string,
    {
      statement: import("node:sqlite").StatementSync;
      hasRows: boolean;
      expiresAt: number;
    }
  >();
  port.on("message", (command: WorkerCommand) => {
    let operation = command.close ? "close" : "prepare";
    try {
      if (command.close) {
        database.close();
        port.postMessage({ id: command.id, result: [] });
        port.close();
        return;
      }
      let entry = command.prepared ? cache.get(command.sql) : undefined;
      if (entry !== undefined && entry.expiresAt <= command.now) {
        cache.delete(command.sql);
        entry = undefined;
      }
      if (entry === undefined) {
        const statement = database.prepare(command.sql);
        entry = {
          statement,
          hasRows: statement.columns().length > 0,
          expiresAt: command.now + options.ttl,
        };
        if (command.prepared && options.capacity > 0) {
          if (cache.size >= options.capacity) cache.delete(cache.keys().next().value!);
          cache.set(command.sql, entry);
        }
      } else {
        cache.delete(command.sql);
        cache.set(command.sql, entry);
      }
      operation = "execute";
      const { statement, hasRows } = entry;
      statement.setReadBigInts(command.safeIntegers);
      statement.setReturnArrays(command.values);
      const params = command.params as import("node:sqlite").SQLInputValue[];
      const result = hasRows ? statement.all(...params) : statement.run(...params);
      port.postMessage({ id: command.id, result: hasRows || command.raw ? result : [] });
    } catch (cause) {
      failure(command.id, operation, cause);
    }
  });
  port.postMessage({ id: 0, result: [] });
}

function workerError(error: WorkerFailure) {
  const cause = Object.assign(new Error(error.message), {
    code: error.code,
    errno: error.errcode,
    errcode: error.errcode,
  });
  return new SqlError({
    reason: classifySqliteError(cause, {
      message: "SQLite worker operation failed",
      operation: error.operation,
    }),
  });
}

export const makeConnection = Effect.fnUntraced(function* (options: SqliteClientConfig) {
  const connection = yield* Effect.acquireRelease(
    Effect.callback<
      {
        readonly request: (
          command: Omit<WorkerCommand, "id">,
        ) => Effect.Effect<ReadonlyArray<unknown>, SqlError>;
        readonly worker: NodeWorkerThreads.Worker;
      },
      SqlError
    >((ready) => {
      const pending = new Map<number, (response: WorkerResponse) => void>();
      let nextId = 1;
      let stopped: WorkerFailure | undefined;
      let worker: NodeWorkerThreads.Worker;
      try {
        worker = new NodeWorkerThreads.Worker("(" + runSqliteWorker.toString() + ")()", {
          eval: true,
          workerData: {
            filename: options.filename,
            readonly: options.readonly,
            allowExtension: options.allowExtension,
            capacity: options.prepareCacheSize ?? 200,
            ttl: Duration.toMillis(options.prepareCacheTTL ?? "10 minutes"),
          },
        });
      } catch (cause) {
        ready(
          Effect.fail(
            new SqlError({
              reason: classifySqliteError(cause, {
                message: "Failed to start SQLite worker",
                operation: "open",
              }),
            }),
          ),
        );
        return;
      }
      const request = (command: Omit<WorkerCommand, "id">) =>
        Effect.callback<ReadonlyArray<unknown>, SqlError>((resume) => {
          if (stopped !== undefined) return resume(Effect.fail(workerError(stopped)));
          const id = nextId++;
          pending.set(id, (response) =>
            resume(
              response.error
                ? Effect.fail(workerError(response.error))
                : Effect.succeed(response.result ?? []),
            ),
          );
          try {
            // Node worker messages use a single structured-clone payload.
            // eslint-disable-next-line unicorn/require-post-message-target-origin
            worker.postMessage({ ...command, id });
          } catch (cause) {
            pending.delete(id);
            resume(
              Effect.fail(
                new SqlError({
                  reason: classifySqliteError(cause, {
                    message: "Failed to send SQLite worker command",
                    operation: "execute",
                  }),
                }),
              ),
            );
          }
          // Retain the connection permit until SQLite finishes. Interruption
          // then rolls back before a later request can reuse the connection.
        }).pipe(Effect.uninterruptible);
      pending.set(0, (response) =>
        ready(
          response.error
            ? Effect.fail(workerError(response.error))
            : Effect.succeed({ request, worker }),
        ),
      );
      worker.on("message", (response: WorkerResponse) => {
        const resume = pending.get(response.id);
        pending.delete(response.id);
        resume?.(response);
      });
      const fail = (error: WorkerFailure) => {
        stopped = error;
        for (const [id, resume] of pending) resume({ id, error });
        pending.clear();
      };
      worker.on("error", (cause) => fail({ message: cause.message, operation: "worker" }));
      worker.on("exit", () => fail({ message: "SQLite worker exited", operation: "worker" }));
    }),
    (connection) =>
      connection
        .request({
          sql: "",
          params: [],
          prepared: false,
          values: false,
          raw: false,
          safeIntegers: false,
          now: 0,
          close: true,
        })
        .pipe(Effect.ensuring(Effect.promise(() => connection.worker.terminate())), Effect.orDie),
  );
  const run = (
    sql: string,
    params: ReadonlyArray<unknown>,
    prepared: boolean,
    values = false,
    raw = false,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      return yield* Effect.withFiber((fiber) =>
        connection.request({
          sql,
          params,
          prepared,
          values,
          raw,
          now,
          safeIntegers: Boolean(Context.get(fiber.context, Client.SafeIntegers)),
        }),
      );
    });
  return {
    execute: (sql, params, transform) =>
      transform
        ? Effect.map(
            run(sql, params, true) as Effect.Effect<ReadonlyArray<object>, SqlError>,
            transform,
          )
        : run(sql, params, true),
    executeRaw: (sql, params) => run(sql, params, true, false, true),
    executeValues: (sql, params) =>
      run(sql, params, true, true) as Effect.Effect<
        ReadonlyArray<ReadonlyArray<unknown>>,
        SqlError
      >,
    executeValuesUnprepared: (sql, params) =>
      run(sql, params ?? [], false, true) as Effect.Effect<
        ReadonlyArray<ReadonlyArray<unknown>>,
        SqlError
      >,
    executeUnprepared: (sql, params, transform) =>
      transform
        ? Effect.map(
            run(sql, params ?? [], false) as Effect.Effect<ReadonlyArray<object>, SqlError>,
            transform,
          )
        : run(sql, params ?? [], false),
  } satisfies Omit<Connection, "executeStream">;
});
