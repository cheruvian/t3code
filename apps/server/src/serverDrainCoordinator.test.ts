import { ThreadId } from "@t3tools/contracts";
import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { CheckpointReactor } from "./orchestration/Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "./orchestration/Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "./orchestration/Services/ProviderRuntimeIngestion.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { SessionReconciler } from "./provider/Services/SessionReconciler.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import { layerTest, ServerDrainCoordinator } from "./serverDrainCoordinator.ts";

const threadId = ThreadId.make("thread-draining");
const activeShell = {
  id: threadId,
  session: { status: "running" },
  hasPendingApprovals: true,
  hasPendingUserInput: false,
};

function testLayer(
  active: boolean | (() => boolean),
  options?: {
    readonly onRuntimeDrain?: () => void;
    readonly onInterrupt?: () => void;
  },
) {
  const interruptActiveSessions = vi.fn(() =>
    Effect.sync(() => {
      options?.onInterrupt?.();
      return {
        inspected: 1,
        reconciled: 1,
        interrupted: 1,
        stopped: 0,
        remainingOrphans: [],
      };
    }),
  );
  const drainProviderRuntime = vi.fn(() => options?.onRuntimeDrain?.());
  const drainProviderCommands = vi.fn();
  const drainCheckpoints = vi.fn();
  const dependencies = Layer.mergeAll(
    Layer.succeed(ProjectionSnapshotQuery, {
      getShellSnapshot: () =>
        Effect.succeed({
          threads: (typeof active === "function" ? active() : active) ? [activeShell] : [],
        }),
    } as never),
    Layer.succeed(OrchestrationEngineService, {
      streamDomainEvents: Stream.empty,
    } as never),
    Layer.succeed(CheckpointReactor, { drain: Effect.sync(drainCheckpoints) } as never),
    Layer.succeed(ProviderCommandReactor, { drain: Effect.sync(drainProviderCommands) } as never),
    Layer.succeed(ProviderRuntimeIngestionService, {
      drain: Effect.sync(drainProviderRuntime),
    } as never),
    Layer.succeed(SessionReconciler, {
      reconcileOrphanedSessions: Effect.die("unexpected startup reconciliation"),
      interruptActiveSessions: interruptActiveSessions(),
    }),
    ServerLifecycleEvents.layer,
    SqlitePersistenceMemory,
  );
  return {
    interruptActiveSessions,
    drainProviderRuntime,
    drainProviderCommands,
    drainCheckpoints,
    layer: layerTest.pipe(Layer.provide(dependencies)),
  };
}

it.effect("gates new turns during a cancellable active-work drain", () => {
  const fixture = testLayer(true);
  return Effect.gen(function* () {
    const coordinator = yield* ServerDrainCoordinator;
    const drain = yield* coordinator.control({ operation: "begin", action: "restart" });
    assert.isNotNull(drain);
    assert.equal(drain?.activeWorkCount, 1);
    assert.deepEqual(drain?.blockedThreadIds, [threadId]);
    assert.equal((yield* Effect.exit(coordinator.assertTurnAdmission))._tag, "Failure");
    yield* coordinator.control({ operation: "cancel", drainId: drain!.id });
    yield* coordinator.assertTurnAdmission;
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("flushes already-admitted provider mutations before exposing an active drain", () => {
  const fixture = testLayer(true);
  return Effect.gen(function* () {
    const coordinator = yield* ServerDrainCoordinator;
    const drain = yield* coordinator.control({ operation: "begin", action: "restart" });
    assert.equal(drain?.phase, "draining");
    assert.equal(fixture.drainProviderCommands.mock.calls.length, 1);
    yield* coordinator.control({ operation: "cancel", drainId: drain!.id });
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("observes lifecycle work produced behind an already-admitted provider command", () => {
  let active = false;
  const fixture = testLayer(() => active, { onRuntimeDrain: () => (active = true) });
  return Effect.gen(function* () {
    const coordinator = yield* ServerDrainCoordinator;
    const drain = yield* coordinator.control({ operation: "begin", action: "restart" });
    assert.equal(drain?.phase, "draining");
    assert.equal(drain?.activeWorkCount, 1);
    assert.equal(fixture.drainProviderCommands.mock.calls.length, 1);
    assert.equal(fixture.drainProviderRuntime.mock.calls.length, 1);
    yield* coordinator.control({ operation: "cancel", drainId: drain!.id });
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("force durably interrupts active work before completing the drain", () => {
  let active = true;
  const fixture = testLayer(() => active, { onInterrupt: () => (active = false) });
  return Effect.gen(function* () {
    const coordinator = yield* ServerDrainCoordinator;
    const drain = yield* coordinator.control({ operation: "begin", action: "shutdown" });
    const completed = yield* coordinator.control({ operation: "force", drainId: drain!.id });
    assert.equal(completed?.phase, "committing");
    assert.equal(completed?.activeWorkCount, 0);
    assert.equal(fixture.interruptActiveSessions.mock.calls.length, 1);
    assert.equal(fixture.drainProviderRuntime.mock.calls.length, 3);
    assert.equal(fixture.drainProviderCommands.mock.calls.length, 3);
    assert.equal(fixture.drainCheckpoints.mock.calls.length, 3);
    assert.equal((yield* coordinator.awaitCommit(drain!.id)).id, drain!.id);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("an idle drain commits immediately", () => {
  const fixture = testLayer(false);
  return Effect.gen(function* () {
    const coordinator = yield* ServerDrainCoordinator;
    const drain = yield* coordinator.control({ operation: "begin", action: "restart" });
    assert.equal(drain?.phase, "committing");
    assert.equal((yield* coordinator.awaitCommit(drain!.id)).activeWorkCount, 0);
    assert.equal(fixture.interruptActiveSessions.mock.calls.length, 1);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("serializes turn admission with beginning a drain", () => {
  let active = false;
  const fixture = testLayer(() => active);
  return Effect.gen(function* () {
    const coordinator = yield* ServerDrainCoordinator;
    const admitted = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const turn = yield* coordinator
      .admitTurn(
        Effect.gen(function* () {
          active = true;
          yield* Deferred.succeed(admitted, undefined);
          yield* Deferred.await(release);
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(admitted);
    const begin = yield* coordinator
      .control({ operation: "begin", action: "restart" })
      .pipe(Effect.forkChild);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(turn);
    const drain = yield* Fiber.join(begin);
    assert.equal(drain?.activeWorkCount, 1);
    yield* coordinator.control({ operation: "cancel", drainId: drain!.id });
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("requires an explicit action after the interactive drain deadline", () => {
  const fixture = testLayer(true);
  return Effect.gen(function* () {
    const coordinator = yield* ServerDrainCoordinator;
    const drain = yield* coordinator.control({ operation: "begin", action: "restart" });
    yield* TestClock.adjust("30 seconds");
    const snapshot = yield* coordinator.snapshot;
    assert.equal(snapshot?.id, drain?.id);
    assert.equal(snapshot?.phase, "action-required");
    yield* coordinator.control({ operation: "cancel", drainId: drain!.id });
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("force-interrupts a signal-driven drain after its bounded deadline", () => {
  let active = true;
  const fixture = testLayer(() => active, { onInterrupt: () => (active = false) });
  return Effect.gen(function* () {
    const coordinator = yield* ServerDrainCoordinator;
    const shutdown = yield* coordinator.drainForProcessExit.pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("5 seconds");
    yield* Fiber.join(shutdown);
    assert.equal(fixture.interruptActiveSessions.mock.calls.length, 1);
    assert.equal((yield* coordinator.snapshot)?.phase, "committing");
  }).pipe(Effect.provide(fixture.layer));
});
