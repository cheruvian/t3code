import { ScheduledTaskError, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";

export class ScheduledTaskStore extends Context.Service<
  ScheduledTaskStore,
  {
    readonly changes: PubSub.PubSub<void>;
    readonly deletions: PubSub.PubSub<ReadonlyArray<ScheduledTaskId>>;
    readonly delete: (id: ScheduledTaskId) => Effect.Effect<void, ScheduledTaskError>;
    /** Delete inside the caller's transaction; publish the returned ids after commit. */
    readonly deleteForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ScheduledTaskId>, ScheduledTaskError>;
    readonly publishDeleted: (ids: ReadonlyArray<ScheduledTaskId>) => Effect.Effect<void>;
    readonly exists: (id: ScheduledTaskId) => Effect.Effect<boolean, ScheduledTaskError>;
  }
>()("t3/scheduledTasks/ScheduledTaskStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Each signal refreshes the full list, so only the latest signal is needed.
  const changes = yield* PubSub.sliding<void>(1);
  const deletions = yield* PubSub.unbounded<ReadonlyArray<ScheduledTaskId>>();
  const publishDeleted = (ids: ReadonlyArray<ScheduledTaskId>) =>
    PubSub.publish(deletions, ids).pipe(
      Effect.andThen(PubSub.publish(changes, undefined)),
      Effect.asVoid,
    );
  const remove = (selector: { id: ScheduledTaskId } | { threadId: ThreadId }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const predicate =
            "id" in selector
              ? sql`task_id = ${selector.id}`
              : sql`thread_id = ${selector.threadId}`;
          yield* sql`DELETE FROM scheduled_task_webhook_deliveries
        WHERE task_id IN (SELECT task_id FROM scheduled_tasks WHERE ${predicate})`;
          return yield* sql<{ task_id: ScheduledTaskId }>`
        DELETE FROM scheduled_tasks WHERE ${predicate} RETURNING task_id
      `;
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new ScheduledTaskError({
              message: "Could not delete schedule tasks.",
              cause,
            }),
        ),
        Effect.map((rows) => rows.map((row) => row.task_id)),
      );
  return ScheduledTaskStore.of({
    changes,
    deletions,
    delete: (id) => remove({ id }).pipe(Effect.flatMap(publishDeleted)),
    deleteForThread: (threadId) => remove({ threadId }),
    publishDeleted,
    exists: (id) =>
      sql`SELECT 1 FROM scheduled_tasks WHERE task_id = ${id}`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(
          (cause) =>
            new ScheduledTaskError({
              taskId: id,
              message: "Could not read schedule task.",
              cause,
            }),
        ),
      ),
  });
});

export const layer = Layer.effect(ScheduledTaskStore, make);
