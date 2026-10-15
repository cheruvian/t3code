// @effect-diagnostics nodeBuiltinImport:off - Names an isolated file-backed database before the runtime starts.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { ReadOnlySqlClient } from "../persistence/Services/ReadOnlySqlClient.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";

const threadId = ThreadId.make("thread:read-isolation");
const providerInstanceId = ProviderInstanceId.make("codex");

const seedThread = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  yield* store.apply({
    id: EventId.make("event:read-isolation:created"),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:read-isolation"),
      title: "Committed",
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
});

const renameThread = (title: string) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const thread = yield* store.getThread(threadId);
    if (thread === null) return yield* Effect.die("Missing read-isolation fixture");
    const now = yield* DateTime.now;
    const event = {
      id: EventId.make(`event:read-isolation:${title}`),
      type: "thread.metadata-updated" as const,
      threadId,
      occurredAt: now,
      payload: { ...thread, title, updatedAt: now },
    };
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    yield* events.appendAgentEvents({ events: [event] });
    yield* store.apply(event);
  });

function withDatabase<A, E, R>(effect: Effect.Effect<A, E, R>) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-projection-reads-"));
  const database = Sqlite.layerFromPath(NodePath.join(directory, "state.sqlite")).pipe(
    Layer.provideMerge(NodeServices.layer),
  );
  return effect.pipe(
    Effect.provide(
      Layer.mergeAll(ProjectionStore.layer, ProjectStore.layer, OrchestrationEventStore.layer).pipe(
        Layer.provideMerge(database),
      ),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
}

it.effect("serves sidebar reads before a continuous writer drains", () =>
  withDatabase(
    Effect.gen(function* () {
      yield* seedThread;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const events = yield* OrchestrationEventStore.OrchestrationEventStore;
      const projects = yield* ProjectStore.ProjectStoreV2;
      const writerOpened = yield* Deferred.make<void>();
      const releaseWriter = yield* Deferred.make<void>();
      const readerStarted = yield* Deferred.make<void>();
      let committed = 0;
      const writer = yield* Effect.gen(function* () {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* renameThread("First write");
            yield* Deferred.succeed(writerOpened, undefined);
            yield* Deferred.await(releaseWriter);
          }),
        );
        for (let index = 0; index < 100; index++) {
          yield* sql.withTransaction(renameThread(`Write ${index}`));
          committed++;
        }
      }).pipe(Effect.forkChild);
      yield* Deferred.await(writerOpened);
      const reader = yield* Effect.gen(function* () {
        yield* Deferred.succeed(readerStarted, undefined);
        const shell = yield* store.getThreadShell(threadId);
        yield* events.latestApplicationSequence;
        yield* projects.listShells();
        const writesBeforeRead = committed;
        assert.isNotNull(shell);
        return writesBeforeRead;
      }).pipe(Effect.forkChild);
      yield* Deferred.await(readerStarted);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseWriter, undefined);
      const writesBeforeRead = yield* Fiber.join(reader);
      yield* Fiber.join(writer);
      assert.isBelow(writesBeforeRead, 100, "sidebar read waited for every later write");
      assert.equal((yield* store.getThreadShell(threadId))?.title, "Write 99");
    }),
  ),
);

it.effect("reads uncommitted projections inside a writer transaction and rolls them back", () =>
  withDatabase(
    Effect.gen(function* () {
      yield* seedThread;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const result = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* renameThread("Uncommitted");
            assert.equal((yield* store.getThread(threadId))?.title, "Uncommitted");
            assert.equal((yield* store.getThreadShell(threadId))?.title, "Uncommitted");
            return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.flip);
      assert.equal(result, "rollback");
      assert.equal((yield* store.getThreadShell(threadId))?.title, "Committed");
    }),
  ),
);

it.effect("keeps projection reads in one WAL snapshot across a concurrent commit", () =>
  withDatabase(
    Effect.gen(function* () {
      yield* seedThread;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const readSql = yield* ReadOnlySqlClient;
      const events = yield* OrchestrationEventStore.OrchestrationEventStore;
      const readOpened = yield* Deferred.make<void>();
      const writeCommitted = yield* Deferred.make<void>();
      const reader = yield* readSql
        .withTransaction(
          Effect.gen(function* () {
            const before = yield* store.getThreadShell(threadId);
            const sequenceBefore = yield* events.latestApplicationSequence;
            yield* Deferred.succeed(readOpened, undefined);
            yield* Deferred.await(writeCommitted);
            const after = yield* store.getThreadShell(threadId);
            const sequenceAfter = yield* events.latestApplicationSequence;
            return [before?.title, after?.title, sequenceBefore, sequenceAfter];
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(readOpened);
      yield* sql.withTransaction(renameThread("Concurrent commit"));
      yield* Deferred.succeed(writeCommitted, undefined);
      assert.deepEqual(yield* Fiber.join(reader), ["Committed", "Committed", 0, 0]);
      assert.equal((yield* store.getThreadShell(threadId))?.title, "Concurrent commit");
      assert.equal(yield* events.latestApplicationSequence, 1);
    }),
  ),
);
