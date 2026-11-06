import * as Fiber from "effect/Fiber";
import { assert, it } from "@effect/vitest";
import { ServerDrainControlError, ThreadId, type ServerDrainSnapshot } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Admission from "./serverDrainAdmission.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ProjectionStoreV2 } from "./orchestration-v2/ProjectionStore.ts";
import { make, readActiveWork } from "./serverDrainCoordinator.ts";

const layer = Layer.mergeAll(Admission.layer, NodeCrypto.layer);
const harness = Effect.gen(function* () {
  const threadId = ThreadId.make("busy");
  const current = yield* Ref.make({
    threadIds: [threadId] as ReadonlyArray<ThreadId>,
    blockedThreadIds: [threadId] as ReadonlyArray<ThreadId>,
  });
  const changes = yield* Queue.unbounded<void>();
  const saved: Array<ServerDrainSnapshot | null> = [];
  const stopped: ThreadId[] = [];
  let resumed = 0;
  const coordinator = yield* make({
    read: Ref.get(current),
    flush: Effect.void,
    stop: (ids) =>
      Effect.sync(() => stopped.push(...ids)).pipe(
        Effect.andThen(Ref.set(current, { threadIds: [], blockedThreadIds: [] })),
      ),
    save: (snapshot) =>
      Effect.sync(() => {
        saved.push(snapshot);
      }),
    changes: Stream.fromQueue(changes),
    resume: Effect.sync(() => {
      resumed++;
    }),
  });
  const gate = yield* Admission.ServerDrainAdmission;
  return { coordinator, current, changes, saved, stopped, gate, resumed: () => resumed };
});

it.effect(
  "waits for active agents, requires action after the deadline, and cancelling reopens admission",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const drain = yield* h.coordinator.control({ operation: "begin", action: "shutdown" });
      assert.isNotNull(drain);
      if (!drain) return;
      assert.equal(drain.phase, "draining");
      assert.equal(drain.activeWorkCount, 1);
      assert.deepEqual(drain.blockedThreadIds, [ThreadId.make("busy")]);
      assert.isFalse(h.gate.enter());
      yield* TestClock.adjust("30 seconds");
      assert.equal(h.saved.at(-1)?.phase, "action-required");
      assert.isEmpty(h.stopped);
      yield* h.coordinator.control({ operation: "cancel", drainId: drain.id });
      assert.isNull(h.saved.at(-1));
      assert.isTrue(h.gate.enter());
      h.gate.leave();
      assert.equal(h.resumed(), 1);
      const result = yield* h.coordinator.awaitCommit(drain.id).pipe(Effect.flip);
      assert.instanceOf(result, ServerDrainControlError);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "commits after the last running agent completes without discarding restart continuation",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const drain = yield* h.coordinator.control({ operation: "begin", action: "update" });
      if (!drain) return yield* Effect.die("missing drain");
      yield* Ref.set(h.current, { threadIds: [], blockedThreadIds: [] });
      yield* Queue.offer(h.changes, undefined);
      const committed = yield* h.coordinator.awaitCommit(drain.id);
      assert.equal(committed.phase, "committing");
      assert.equal(committed.activeWorkCount, 0);
      assert.isEmpty(h.stopped);
      assert.isTrue(h.gate.isClosed());
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "force interrupts active work before reporting committed and rejects stale cancellation",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const drain = yield* h.coordinator.control({ operation: "begin", action: "restart" });
      if (!drain) return yield* Effect.die("missing drain");
      const stale = yield* h.coordinator
        .control({ operation: "cancel", drainId: "stale" })
        .pipe(Effect.flip);
      assert.equal(stale.reason, "drain-mismatch");
      assert.isTrue(h.gate.isClosed());
      yield* h.coordinator.control({ operation: "force", drainId: drain.id });
      assert.deepEqual(h.stopped, [ThreadId.make("busy")]);
      assert.equal((yield* h.coordinator.awaitCommit(drain.id)).activeWorkCount, 0);
      const cancel = yield* h.coordinator
        .control({ operation: "cancel", drainId: drain.id })
        .pipe(Effect.flip);
      assert.equal(cancel.reason, "already-committing");
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "reopens admission after a committed update fails, without allowing shutdown to be cancelled after commit",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Ref.set(h.current, { threadIds: [], blockedThreadIds: [] });
      const drain = yield* h.coordinator.control({ operation: "begin", action: "update" });
      if (!drain) return yield* Effect.die("missing drain");
      assert.equal((yield* h.coordinator.awaitCommit(drain.id)).activeWorkCount, 0);
      assert.isTrue(h.gate.isClosed());
      const stale = yield* h.coordinator
        .control({ operation: "resume", drainId: "stale" })
        .pipe(Effect.flip);
      assert.equal(stale.reason, "drain-mismatch");
      yield* h.coordinator.control({ operation: "resume", drainId: drain.id });
      assert.isFalse(h.gate.isClosed());
      assert.isNull(h.saved.at(-1));
      assert.equal(h.resumed(), 1);
      const shutdown = yield* h.coordinator.control({ operation: "begin", action: "shutdown" });
      if (!shutdown) return yield* Effect.die("missing shutdown");
      const resume = yield* h.coordinator
        .control({ operation: "resume", drainId: shutdown.id })
        .pipe(Effect.flip);
      assert.equal(resume.reason, "already-draining");
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "counts durable waiting and silent runs even when the shell omits them, and excludes queued work",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, status TEXT)`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES ('waiting', 'waiting'), ('silent', 'running'), ('queued', 'queued'), ('completed', 'completed')`;
      const active = yield* readActiveWork;
      assert.deepEqual(active.threadIds.toSorted(), [
        ThreadId.make("silent"),
        ThreadId.make("waiting"),
      ]);
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE status IN ('running', 'waiting')`;
      assert.isEmpty((yield* readActiveWork).threadIds);
    }).pipe(
      Effect.provide([
        NodeSqliteClient.layer({ filename: ":memory:" }),
        Layer.mock(ProjectionStoreV2)({
          getShellSnapshot: () =>
            Effect.succeed({
              threads: [],
              archivedThreads: [],
            } as unknown as import("@t3tools/contracts").OrchestrationV2ShellSnapshot),
        }),
      ]),
    ),
);

it.effect(
  "bounds process-exit waiting without converting restart continuation into a user Stop",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const exit = yield* h.coordinator.drainForProcessExit.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      assert.isTrue(h.gate.isClosed());
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(exit);
      assert.isEmpty(h.stopped);
      assert.equal((yield* Ref.get(h.current)).threadIds.length, 1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
