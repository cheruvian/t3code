import {
  EnvironmentId,
  EventId,
  MessageId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  NodeId,
  type OrchestrationV2AssistantMessageItem,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "../rpc/session.ts";
import { v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import * as ThreadHistoryController from "./threadHistoryController.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  makeEnvironmentThreadState,
  type EnvironmentThreadState,
  type ThreadSnapshotLoadResult,
} from "./threads.ts";
import * as ThreadSnapshotLoader from "./threadSnapshotHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const THREAD_ID = v2ThreadId;
const CACHED_SNAPSHOT_SEQUENCE = 7;
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};
const BASE_PROJECTION: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  thread: { ...v2Projection.thread, title: "Cached thread" },
};

type TestThreadInput = OrchestrationV2ThreadStreamItem | Error;

function testSession(
  client: WsRpcProtocolClient,
  config?: { readonly completionMarker?: boolean; readonly assistantPreviews?: boolean },
): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.succeed({
      ...(config?.completionMarker === true ? { threadResumeCompletionMarker: true } : {}),
      ...(config?.assistantPreviews === true ? { assistantPreviews: true } : {}),
    } as never),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

function awaitThreadState(
  observed: Queue.Queue<EnvironmentThreadState>,
  predicate: (state: EnvironmentThreadState) => boolean,
) {
  return Queue.take(observed).pipe(
    Effect.repeat({
      until: predicate,
    }),
  );
}

const makeHarness = Effect.fn("TestEnvironmentThreads.makeHarness")(function* (options?: {
  readonly cached?: OrchestrationV2ThreadProjection;
  readonly cachedHistory?: {
    readonly historyCursor: string | null;
    readonly hasMoreHistory: boolean;
    readonly latestLocalTurnOrdinal?: number | null;
  };
  readonly httpSnapshot?: ThreadSnapshotLoadResult;
  readonly completionMarker?: boolean;
  readonly assistantPreviews?: boolean;
  readonly resumeCache?: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]>;
  readonly loadCached?: ReturnType<Persistence.EnvironmentCacheStore["Service"]["loadThread"]>;
  readonly saveThread?: Persistence.EnvironmentCacheStore["Service"]["saveThread"];
  readonly historyPaging?: "enabled" | "no-http" | "no-controller";
  readonly historyHttpClient?: HttpClient.HttpClient;
}) {
  const inputs = yield* Queue.unbounded<TestThreadInput>();
  const observed = yield* Queue.unbounded<EnvironmentThreadState>();
  const latest = yield* Ref.make<EnvironmentThreadState>(EMPTY_ENVIRONMENT_THREAD_STATE);
  const retryCount = yield* Ref.make(0);
  const subscriptionCount = yield* Ref.make(0);
  const loaderCalls = yield* Ref.make(0);
  const lastSubscribeAfterSequence = yield* Ref.make<number | undefined>(undefined);
  const lastRequestCompletionMarker = yield* Ref.make(false);
  const lastAcceptBoundedSnapshot = yield* Ref.make<true | undefined>(undefined);
  const lastAcceptCompactTurnItems = yield* Ref.make<true | undefined>(undefined);
  const lastAcceptAssistantPreviews = yield* Ref.make<true | undefined>(undefined);
  const wakeups = yield* Queue.unbounded<ConnectionWakeups.ConnectionWakeup>();
  const savedThreads = yield* Ref.make<ReadonlyArray<OrchestrationV2ThreadDetailSnapshot>>([]);
  const removedThreads = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>(
    AVAILABLE_CONNECTION_STATE,
  );
  const streamFrom = (queue: Queue.Queue<TestThreadInput>) =>
    Stream.fromQueue(queue).pipe(
      Stream.mapEffect((input) =>
        input instanceof Error ? Effect.fail(input) : Effect.succeed(input),
      ),
    );
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input: {
      readonly afterSequence?: number;
      readonly requestCompletionMarker?: true;
      readonly acceptBoundedSnapshot?: true;
      readonly acceptCompactTurnItems?: true;
      readonly acceptAssistantPreviews?: true;
    }) =>
      Stream.unwrap(
        Ref.updateAndGet(subscriptionCount, (count) => count + 1).pipe(
          Effect.andThen(Ref.set(lastSubscribeAfterSequence, input.afterSequence)),
          Effect.andThen(
            Ref.set(lastRequestCompletionMarker, input.requestCompletionMarker === true),
          ),
          Effect.andThen(Ref.set(lastAcceptBoundedSnapshot, input.acceptBoundedSnapshot)),
          Effect.andThen(Ref.set(lastAcceptCompactTurnItems, input.acceptCompactTurnItems)),
          Effect.andThen(Ref.set(lastAcceptAssistantPreviews, input.acceptAssistantPreviews)),
          Effect.as(streamFrom(inputs)),
        ),
      ),
  } as unknown as WsRpcProtocolClient;
  const supervisorSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.some(testSession(client, options)),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
    Option.some(PREPARED),
  );
  const snapshotLoader = ThreadSnapshotLoader.ThreadSnapshotLoader.of({
    load: (_prepared, threadId) =>
      Ref.update(loaderCalls, (count) => count + 1).pipe(
        Effect.as(
          threadId === THREAD_ID
            ? (options?.httpSnapshot ??
                ({ _tag: "unavailable" } satisfies ThreadSnapshotLoadResult))
            : ({ _tag: "unavailable" } satisfies ThreadSnapshotLoadResult),
        ),
      ),
  });
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: supervisorState,
    session: supervisorSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Ref.update(retryCount, (count) => count + 1),
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: (_environmentId, threadId) =>
      options?.loadCached ??
      Effect.succeed(
        threadId === THREAD_ID && options?.cached !== undefined
          ? Option.some({
              snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
              projection: options.cached,
              ...(options.cachedHistory === undefined
                ? {}
                : {
                    historyCursor: options.cachedHistory.historyCursor,
                    hasMoreHistory: options.cachedHistory.hasMoreHistory,
                    ...(options.cachedHistory.latestLocalTurnOrdinal === undefined
                      ? {}
                      : {
                          latestLocalTurnOrdinal: options.cachedHistory.latestLocalTurnOrdinal,
                        }),
                  }),
            })
          : Option.none(),
      ),
    saveThread: (environmentId, thread) =>
      Ref.update(savedThreads, (current) => [...current, thread]).pipe(
        Effect.andThen(options?.saveThread?.(environmentId, thread) ?? Effect.void),
      ),
    removeThread: (_environmentId, threadId) =>
      Ref.update(removedThreads, (current) => [...current, threadId]),
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  let makeThreadState = makeEnvironmentThreadState(THREAD_ID, options?.resumeCache).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    Effect.provideService(ThreadSnapshotLoader.ThreadSnapshotLoader, snapshotLoader),
    Effect.provideService(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.fromQueue(wakeups) }),
    ),
  );
  if (options?.historyPaging !== "no-http") {
    makeThreadState = makeThreadState.pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        options?.historyHttpClient ??
          HttpClient.make(() => Effect.die("Unexpected history HTTP request")),
      ),
    );
  }
  const historyController = yield* ThreadHistoryController.ThreadHistoryController.pipe(
    Effect.provide(ThreadHistoryController.layer),
  );
  if (options?.historyPaging !== "no-controller") {
    makeThreadState = makeThreadState.pipe(
      Effect.provideService(ThreadHistoryController.ThreadHistoryController, historyController),
    );
  }
  const threadState = yield* makeThreadState;
  yield* SubscriptionRef.changes(threadState).pipe(
    Stream.runForEach((state) =>
      Ref.set(latest, state).pipe(Effect.andThen(Queue.offer(observed, state))),
    ),
    Effect.forkScoped,
  );

  return {
    threadState,
    loadEarlier: (throughEntryId?: string) =>
      historyController.loadEarlier(TARGET.environmentId, THREAD_ID, throughEntryId),
    inputs,
    observed,
    latest,
    retryCount,
    subscriptionCount,
    loaderCalls,
    lastSubscribeAfterSequence,
    lastRequestCompletionMarker,
    lastAcceptBoundedSnapshot,
    lastAcceptCompactTurnItems,
    lastAcceptAssistantPreviews,
    supervisorState,
    supervisorSession,
    savedThreads,
    removedThreads,
    wakeups,
    replaceSession: SubscriptionRef.set(
      supervisorSession,
      Option.some(testSession(client, options)),
    ),
  };
});

const snapshot = (
  projection: OrchestrationV2ThreadProjection,
  snapshotSequence = 1,
): Extract<OrchestrationV2ThreadStreamItem, { readonly kind: "snapshot" }> => ({
  kind: "snapshot",
  snapshotSequence,
  projection,
});

const synchronized = (): OrchestrationV2ThreadStreamItem => ({ kind: "synchronized" });

const titleUpdated = (title: string, sequence = 2): OrchestrationV2ThreadStreamItem => {
  const occurredAt = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
  return {
    kind: "event",
    sequence,
    event: {
      id: EventId.make("event-title"),
      type: "thread.metadata-updated",
      threadId: THREAD_ID,
      occurredAt,
      payload: { ...v2Projection.thread, title, updatedAt: occurredAt },
    },
  };
};

const deleted = (sequence = 3): OrchestrationV2ThreadStreamItem => {
  const occurredAt = DateTime.makeUnsafe("2026-06-20T02:00:00.000Z");
  return {
    kind: "event",
    sequence,
    event: {
      id: EventId.make("event-deleted"),
      type: "thread.deleted",
      threadId: THREAD_ID,
      occurredAt,
      payload: { ...v2Projection.thread, updatedAt: occurredAt, deletedAt: occurredAt },
    },
  };
};

const earlyItem: OrchestrationV2AssistantMessageItem = {
  id: TurnItemId.make("early-item"),
  threadId: THREAD_ID,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "running",
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-10-15T00:00:00Z"),
  type: "assistant_message",
  messageId: MessageId.make("early-message"),
  text: "Early snippet",
  streaming: true,
};

describe("EnvironmentThreads", () => {
  it.effect(
    "keeps previews transient, replaces them with durable text, and ignores late duplicates",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ cached: BASE_PROJECTION, assistantPreviews: true });
        yield* awaitThreadState(h.observed, (state) => state.status === "live");
        yield* Queue.offer(h.inputs, { kind: "assistant-preview", item: earlyItem });
        const preview = yield* awaitThreadState(
          h.observed,
          (state) => state.assistantPreviews?.length === 1,
        );
        expect(Option.getOrThrow(preview.data)).toEqual(BASE_PROJECTION);
        yield* TestClock.adjust("500 millis");
        expect(yield* Ref.get(h.savedThreads)).toEqual([]);
        const completed = {
          ...earlyItem,
          text: "Complete reply",
          streaming: false,
          status: "completed" as const,
        };
        yield* Queue.offer(h.inputs, {
          kind: "event",
          sequence: 8,
          event: {
            id: EventId.make("reply-completed"),
            type: "turn-item.updated",
            threadId: THREAD_ID,
            occurredAt: earlyItem.updatedAt,
            payload: completed,
          },
        });
        const durable = yield* awaitThreadState(
          h.observed,
          (state) =>
            Option.isSome(state.data) &&
            state.data.value.turnItems.some((item) => item.id === earlyItem.id),
        );
        expect(durable.assistantPreviews).toEqual([]);
        yield* Queue.offer(h.inputs, { kind: "assistant-preview", item: earlyItem });
        yield* Queue.offer(h.inputs, titleUpdated("After late preview", 9));
        const after = yield* awaitThreadState(
          h.observed,
          (state) =>
            Option.isSome(state.data) && state.data.value.thread.title === "After late preview",
        );
        expect(after.assistantPreviews).toEqual([]);
        yield* TestClock.adjust("500 millis");
        const saved = yield* Ref.get(h.savedThreads);
        expect(saved.at(-1)?.snapshotSequence).toBe(9);
        expect(saved.at(-1)?.projection.turnItems.find((item) => item.id === earlyItem.id)).toEqual(
          completed,
        );
        expect(JSON.stringify(saved)).not.toContain("Early snippet");
      }),
  );

  it.effect("drops previews on a snapshot and reconnects from the durable cursor", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ cached: BASE_PROJECTION, assistantPreviews: true });
      yield* awaitThreadState(h.observed, (state) => state.status === "live");
      yield* Queue.offer(h.inputs, { kind: "assistant-preview", item: earlyItem });
      yield* awaitThreadState(h.observed, (state) => state.assistantPreviews?.length === 1);
      yield* Queue.offer(h.inputs, snapshot(BASE_PROJECTION, 7));
      yield* awaitThreadState(h.observed, (state) => state.assistantPreviews?.length === 0);
      yield* Queue.offer(h.inputs, { kind: "assistant-preview", item: earlyItem });
      yield* awaitThreadState(h.observed, (state) => state.assistantPreviews?.length === 1);
      yield* h.replaceSession;
      const reconnected = yield* awaitThreadState(
        h.observed,
        (state) => state.assistantPreviews?.length === 0 && state.status === "live",
      );
      expect(Option.getOrThrow(reconnected.data)).toEqual(BASE_PROJECTION);
      expect(yield* Ref.get(h.lastSubscribeAfterSequence)).toBe(7);
    }),
  );

  it.effect.each(["completed", "interrupted", "failed", "cancelled"] as const)(
    "clears a preview when its provider turn is %s and ignores late snippets",
    (status) =>
      Effect.gen(function* () {
        const providerTurnId = ProviderTurnId.make("preview-turn");
        const turn = {
          id: providerTurnId,
          providerThreadId: ProviderThreadId.make("preview-provider-thread"),
          nodeId: NodeId.make("preview-root"),
          runAttemptId: RunAttemptId.make("preview-attempt"),
          nativeTurnRef: null,
          ordinal: 1,
          status: "running" as const,
          startedAt: earlyItem.updatedAt,
          completedAt: null,
        };
        const h = yield* makeHarness({
          cached: { ...BASE_PROJECTION, providerTurns: [turn] },
          assistantPreviews: true,
        });
        yield* awaitThreadState(h.observed, (state) => state.status === "live");
        const item = { ...earlyItem, providerTurnId };
        yield* Queue.offer(h.inputs, { kind: "assistant-preview", item });
        yield* awaitThreadState(h.observed, (state) => state.assistantPreviews?.length === 1);
        yield* Queue.offer(h.inputs, {
          kind: "event",
          sequence: 8,
          event: {
            id: EventId.make("preview-turn-settled"),
            type: "provider-turn.updated",
            threadId: THREAD_ID,
            occurredAt: earlyItem.updatedAt,
            payload: { ...turn, status, completedAt: earlyItem.updatedAt },
          },
        });
        yield* awaitThreadState(h.observed, (state) => state.assistantPreviews?.length === 0);
        yield* Queue.offer(h.inputs, { kind: "assistant-preview", item });
        yield* Queue.offer(h.inputs, titleUpdated("Late preview ignored", 9));
        const state = yield* awaitThreadState(
          h.observed,
          (state) =>
            Option.isSome(state.data) && state.data.value.thread.title === "Late preview ignored",
        );
        expect(state.assistantPreviews).toEqual([]);
      }),
  );

  it.effect.each([false, true])(
    "requests assistant previews only when advertised (%s)",
    (assistantPreviews) =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ cached: BASE_PROJECTION, assistantPreviews });
        yield* awaitThreadState(h.observed, (state) => state.status === "live");
        expect(yield* Ref.get(h.lastAcceptAssistantPreviews)).toBe(
          assistantPreviews ? true : undefined,
        );
      }),
  );

  it.effect("loads the server thread when its local cache read fails", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        loadCached: Effect.fail(
          new Persistence.ConnectionPersistenceError({
            operation: "load-thread",
            message: "The database connection is closing.",
          }),
        ),
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: 7, projection: BASE_PROJECTION },
        },
      });

      const state = yield* awaitThreadState(h.observed, (value) => value.status === "live");
      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
      expect(yield* Ref.get(h.loaderCalls)).toBe(1);
      expect(yield* Ref.get(h.subscriptionCount)).toBe(1);
    }),
  );

  it.effect.each(["disk", "HTTP"] as const)(
    "does not rewrite an unchanged %s snapshot on navigation or warm return",
    (source) =>
      Effect.gen(function* () {
        const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
          snapshot: undefined,
          owner: undefined,
        };
        const firstSaved = yield* Effect.scoped(
          Effect.gen(function* () {
            const h = yield* makeHarness({
              resumeCache,
              ...(source === "disk"
                ? { cached: BASE_PROJECTION }
                : {
                    httpSnapshot: {
                      _tag: "present",
                      snapshot: { snapshotSequence: 7, projection: BASE_PROJECTION },
                    },
                  }),
            });
            yield* awaitThreadState(h.observed, (value) => value.status === "live");
            if (source === "HTTP") yield* TestClock.adjust("500 millis");
            return h.savedThreads;
          }),
        );
        expect(yield* Ref.get(firstSaved)).toHaveLength(source === "disk" ? 0 : 1);
        const nextSaved = yield* Effect.scoped(
          Effect.gen(function* () {
            const h = yield* makeHarness({ resumeCache });
            yield* awaitThreadState(h.observed, (value) => value.status === "live");
            return h.savedThreads;
          }),
        );
        expect(yield* Ref.get(nextSaved)).toEqual([]);
      }),
  );

  it.effect("persists a complete bounded HTTP window only once", () =>
    Effect.gen(function* () {
      const saved = yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness({
            httpSnapshot: {
              _tag: "present",
              snapshot: { snapshotSequence: 7, projection: BASE_PROJECTION },
              history: {
                historyCursor: null,
                hasMoreHistory: false,
                latestLocalTurnOrdinal: 12,
              },
            },
          });
          yield* awaitThreadState(h.observed, (value) => value.status === "live");
          yield* TestClock.adjust("500 millis");
          return h.savedThreads;
        }),
      );
      expect(yield* Ref.get(saved)).toEqual([
        {
          snapshotSequence: 7,
          projection: BASE_PROJECTION,
          historyCursor: null,
          hasMoreHistory: false,
          latestLocalTurnOrdinal: 12,
        },
      ]);
    }),
  );

  it.effect("retries a failed background cache write when the scope closes", () =>
    Effect.gen(function* () {
      let attempts = 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness({
            httpSnapshot: {
              _tag: "present",
              snapshot: { snapshotSequence: 7, projection: BASE_PROJECTION },
            },
            saveThread: () =>
              Effect.suspend(() => {
                attempts += 1;
                return attempts === 1
                  ? Effect.fail(
                      new Persistence.ConnectionPersistenceError({
                        operation: "save-thread",
                        message: "Test storage failure",
                      }),
                    )
                  : Effect.void;
              }),
          });
          yield* awaitThreadState(h.observed, (value) => value.status === "live");
          yield* TestClock.adjust("500 millis");
          expect(attempts).toBe(1);
        }),
      );
      expect(attempts).toBe(2);
    }),
  );

  it.effect("prevents an old scope from replacing its successor's cached data", () =>
    Effect.gen(function* () {
      const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
        snapshot: undefined,
        owner: undefined,
      };
      const oldScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const old = yield* makeHarness({ cached: BASE_PROJECTION, resumeCache }).pipe(
        Effect.provideService(Scope.Scope, oldScope),
      );
      yield* awaitThreadState(old.observed, (value) => value.status === "live");
      const successor = yield* makeHarness({ resumeCache });
      yield* Queue.offer(successor.inputs, titleUpdated("Successor title", 9));
      yield* awaitThreadState(
        successor.observed,
        (value) => Option.getOrNull(value.data)?.thread.title === "Successor title",
      );
      yield* Queue.offer(old.inputs, titleUpdated("Old scope title", 8));
      yield* awaitThreadState(
        old.observed,
        (value) => Option.getOrNull(value.data)?.thread.title === "Old scope title",
      );
      yield* Scope.close(oldScope, Exit.void);

      expect(resumeCache.snapshot?.sequence).toBe(9);
      expect(Option.getOrThrow(resumeCache.snapshot!.state.data).thread.title).toBe(
        "Successor title",
      );
      expect(yield* Ref.get(old.savedThreads)).toEqual([]);
    }),
  );

  it.effect("publishes cached data immediately from a warm cache", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      const state = yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));

      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
      expect(Option.isNone(state.error)).toBe(true);
    }),
  );

  it.effect("coalesces streaming cache writes and flushes the latest thread on teardown", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const harness = yield* makeHarness().pipe(Effect.provideService(Scope.Scope, scope));
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* awaitThreadState(harness.observed, (state) => state.status === "live");
      yield* TestClock.adjust("500 millis");
      expect(yield* Ref.get(harness.savedThreads)).toHaveLength(1);

      for (let sequence = 2; sequence <= 10; sequence++) {
        yield* Queue.offer(harness.inputs, titleUpdated(`Title ${sequence}`, sequence));
        yield* awaitThreadState(
          harness.observed,
          (state) =>
            Option.isSome(state.data) && state.data.value.thread.title === `Title ${sequence}`,
        );
        yield* TestClock.adjust("1 second");
      }
      expect(yield* Ref.get(harness.savedThreads)).toHaveLength(1);
      yield* TestClock.adjust("1 second");
      expect((yield* Ref.get(harness.savedThreads)).map((saved) => saved.snapshotSequence)).toEqual(
        [1, 10],
      );

      yield* Queue.offer(harness.inputs, titleUpdated("Final title", 11));
      yield* awaitThreadState(
        harness.observed,
        (state) => Option.isSome(state.data) && state.data.value.thread.title === "Final title",
      );
      yield* Scope.close(scope, Exit.void);
      expect((yield* Ref.get(harness.savedThreads)).map((saved) => saved.snapshotSequence)).toEqual(
        [1, 10, 11],
      );
    }),
  );

  it.effect("reduces live events and persists the latest thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* Queue.offer(harness.inputs, titleUpdated("Live title"));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Live title",
      );
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;

      expect(Option.getOrThrow(state.data).thread.title).toBe("Live title");
      expect((yield* Ref.get(harness.savedThreads)).at(-1)?.projection.thread.title).toBe(
        "Live title",
      );
      expect((yield* Ref.get(harness.savedThreads)).at(-1)?.snapshotSequence).toBe(2);
    }),
  );

  it.effect("keeps progressive history metadata from a bounded socket fallback", () =>
    Effect.gen(function* () {
      const olderItem = {
        id: "item:older",
        threadId: THREAD_ID,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: "2026-06-20T00:00:00.000Z",
        completedAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
        type: "command_execution",
        input: "pwd",
        output: "older history",
        exitCode: 0,
      };
      const harness = yield* makeHarness({
        historyHttpClient: HttpClient.make((request, url) => {
          expect(url.searchParams.get("cursor")).toBe("socket-history-cursor");
          expect(url.searchParams.get("throughEntryId")).toBe(olderItem.id);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                snapshotSequence: 14,
                items: [
                  {
                    position: 0,
                    visibility: "local",
                    sourceThreadId: THREAD_ID,
                    sourceItemId: olderItem.id,
                    item: olderItem,
                  },
                ],
                nextCursor: null,
                hasMoreHistory: false,
              }),
            ),
          );
        }),
      });
      yield* Queue.offer(harness.inputs, {
        kind: "snapshot",
        snapshotSequence: 14,
        projection: BASE_PROJECTION,
        historyCursor: "socket-history-cursor",
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 47,
        payloadBudgetExceeded: false,
      });

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" && value.history.historyCursor === "socket-history-cursor",
      );
      expect(state.history).toMatchObject({
        historyCursor: "socket-history-cursor",
        hasMoreHistory: true,
        loading: false,
        error: null,
        expanded: false,
        latestLocalTurnOrdinal: 47,
      });
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBeUndefined();
      expect(yield* Ref.get(harness.lastAcceptBoundedSnapshot)).toBe(true);

      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;
      expect((yield* Ref.get(harness.savedThreads)).at(-1)).toMatchObject({
        snapshotSequence: 14,
        historyCursor: "socket-history-cursor",
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 47,
      });
      expect(yield* harness.loadEarlier(olderItem.id)).toEqual({ _tag: "loaded" });
      const expanded = yield* SubscriptionRef.get(harness.threadState);
      expect(
        Option.getOrThrow(expanded.data).turnItems.some((item) => item.id === olderItem.id),
      ).toBe(true);
      expect(expanded.history.hasMoreHistory).toBe(false);
    }),
  );

  it.effect.each(["complete", "replacement snapshot", "retry"] as const)(
    "progressively reveals conversation history before activity, then handles %s",
    (mode) =>
      Effect.gen(function* () {
        const common = {
          threadId: THREAD_ID,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          status: "completed",
          title: null,
          startedAt: "2026-06-20T00:00:00.000Z",
          completedAt: "2026-06-20T00:00:00.000Z",
          updatedAt: "2026-06-20T00:00:00.000Z",
        };
        const message = {
          ...common,
          id: "item:older-message",
          ordinal: 1,
          type: "assistant_message",
          messageId: "message:older",
          text: "COD4 result",
          streaming: false,
        };
        const activity = {
          ...common,
          id: "item:older-command",
          ordinal: 2,
          type: "command_execution",
          input: "pwd",
          output: "",
          exitCode: 0,
        };
        const projected = (item: typeof message | typeof activity, position: number) => ({
          position,
          visibility: "local",
          sourceThreadId: THREAD_ID,
          sourceItemId: item.id,
          item,
        });
        const activityStarted = yield* Deferred.make<void>();
        const releaseActivity = yield* Deferred.make<void>();
        let activityRequests = 0;
        const harness = yield* makeHarness({
          historyHttpClient: HttpClient.make((request, url) =>
            Effect.gen(function* () {
              expect(url.searchParams.get("cursor")).toBe("progressive-cursor");
              const conversationOnly = url.searchParams.get("view") === "conversation";
              if (!conversationOnly && activityRequests++ === 0) {
                yield* Deferred.succeed(activityStarted, undefined);
                yield* Deferred.await(releaseActivity);
                if (mode === "retry")
                  return HttpClientResponse.fromWeb(
                    request,
                    new Response("Activity unavailable", { status: 503 }),
                  );
              }
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  snapshotSequence: 14,
                  items: conversationOnly
                    ? [projected(message, 0)]
                    : [projected(message, 0), projected(activity, 1)],
                  nextCursor: "next-cursor",
                  hasMoreHistory: true,
                }),
              );
            }),
          ),
        });
        yield* Queue.offer(harness.inputs, {
          ...snapshot(BASE_PROJECTION, 14),
          historyCursor: "progressive-cursor",
          hasMoreHistory: true,
          latestLocalTurnOrdinal: 47,
          payloadBudgetExceeded: false,
        });
        yield* awaitThreadState(
          harness.observed,
          (state) => state.history.historyCursor === "progressive-cursor",
        );
        const loading = yield* harness.loadEarlier(message.messageId).pipe(Effect.forkScoped);
        yield* Deferred.await(activityStarted);
        const preview = yield* SubscriptionRef.get(harness.threadState);
        expect(preview.history).toMatchObject({
          loading: true,
          historyCursor: "progressive-cursor",
          expanded: true,
        });
        expect(
          Option.getOrThrow(preview.data).visibleTurnItems.map((row) => row.sourceItemId),
        ).toEqual([message.id]);
        if (mode === "replacement snapshot") {
          yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION, 15));
          yield* awaitThreadState(
            harness.observed,
            (state) => state.history.historyCursor === null,
          );
        }
        yield* Deferred.succeed(releaseActivity, undefined);
        const result = yield* Fiber.join(loading);
        if (mode === "replacement snapshot") {
          expect(result).toEqual({ _tag: "noop" });
          const state = yield* SubscriptionRef.get(harness.threadState);
          expect(Option.getOrThrow(state.data).visibleTurnItems).toEqual(
            BASE_PROJECTION.visibleTurnItems,
          );
          expect(state.history.historyCursor).toBeNull();
          return;
        }
        if (mode === "retry") {
          expect(result._tag).toBe("error");
          expect(yield* harness.loadEarlier()).toEqual({ _tag: "loaded" });
        } else expect(result).toEqual({ _tag: "loaded" });
        const complete = yield* SubscriptionRef.get(harness.threadState);
        expect(complete.history).toMatchObject({
          loading: false,
          historyCursor: "next-cursor",
          error: null,
          latestLocalTurnOrdinal: 47,
        });
        expect(
          Option.getOrThrow(complete.data).visibleTurnItems.map((row) => row.sourceItemId),
        ).toEqual([message.id, activity.id]);
        expect(Option.getOrThrow(complete.data).turnItems).toHaveLength(2);
      }),
  );

  it.effect("restores compact socket snapshot turnItems before reducing and caching", () =>
    Effect.gen(function* () {
      const at = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
      const command = (id: string, ordinal: number, threadId = THREAD_ID) =>
        ({
          id: TurnItemId.make(id),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: "completed" as const,
          title: null,
          startedAt: at,
          completedAt: at,
          updatedAt: at,
          type: "command_execution" as const,
          input: id,
          output: id,
          exitCode: 0,
        }) satisfies OrchestrationV2TurnItem;
      const parentThread = ThreadId.make("thread:compact-parent");
      const inherited = command("parent-item", 1, parentThread);
      const local = [command("local-1", 1), command("local-2", 2)];
      const retainedRequest = {
        ...command("retained-request", 0),
        type: "run_interrupt_request" as const,
        message: "Stop",
      } as unknown as OrchestrationV2TurnItem;
      const visibleTurnItems = [
        {
          position: 0,
          visibility: "inherited" as const,
          sourceThreadId: parentThread,
          sourceItemId: inherited.id,
          item: inherited,
        },
        ...local.map((item, index) => ({
          position: index + 1,
          visibility: "local" as const,
          sourceThreadId: THREAD_ID,
          sourceItemId: item.id,
          item,
        })),
      ];
      const harness = yield* makeHarness();
      yield* Queue.offer(harness.inputs, {
        kind: "snapshot",
        snapshotSequence: 5,
        projection: { ...BASE_PROJECTION, turnItems: [retainedRequest], visibleTurnItems },
        historyCursor: "compact-cursor",
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 2,
        payloadBudgetExceeded: false,
        turnItemsOmitLocalVisible: true,
      });

      const seeded = yield* awaitThreadState(
        harness.observed,
        (value) => value.history.historyCursor === "compact-cursor",
      );
      expect(Option.getOrThrow(seeded.data).turnItems).toEqual([...local, retainedRequest]);
      expect(yield* Ref.get(harness.lastAcceptBoundedSnapshot)).toBe(true);
      expect(yield* Ref.get(harness.lastAcceptCompactTurnItems)).toBe(true);

      const updated = { ...local[1]!, output: "updated", ordinal: 2 };
      yield* Queue.offer(harness.inputs, {
        kind: "event",
        sequence: 6,
        event: {
          id: EventId.make("event-compact-update"),
          type: "turn-item.updated",
          threadId: THREAD_ID,
          occurredAt: at,
          payload: updated,
        },
      });
      const live = yield* awaitThreadState(harness.observed, (value) =>
        Option.exists(value.data, (data) =>
          data.turnItems.some(
            (item) => item.type === "command_execution" && item.output === "updated",
          ),
        ),
      );
      expect(Option.getOrThrow(live.data).turnItems.map((item) => String(item.id))).toEqual([
        "local-1",
        "local-2",
        "retained-request",
      ]);

      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;
      const saved = (yield* Ref.get(harness.savedThreads)).at(-1);
      expect(saved?.projection.turnItems.map((item) => String(item.id))).toEqual([
        "local-1",
        "local-2",
        "retained-request",
      ]);
      expect(saved && "turnItemsOmitLocalVisible" in saved).toBe(false);
    }),
  );

  it.effect("seeds the thread from the HTTP snapshot and resumes live events", () =>
    Effect.gen(function* () {
      const httpProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "HTTP title" },
      };
      const harness = yield* makeHarness({
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: 1, projection: httpProjection },
        },
      });
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", 2));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Live title",
      );

      expect(Option.getOrThrow(state.data).thread.title).toBe("Live title");
      expect(yield* Ref.get(harness.loaderCalls)).toBeGreaterThanOrEqual(1);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(1);
      expect(yield* Ref.get(harness.lastAcceptBoundedSnapshot)).toBe(true);
    }),
  );

  it.effect("persists progressive history meta with a settled bounded snapshot", () =>
    Effect.gen(function* () {
      const httpProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "Bounded cache title" },
      };
      const harness = yield* makeHarness({
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: 4, projection: httpProjection },
          history: {
            historyCursor: "cursor-oldest",
            hasMoreHistory: true,
          },
        },
      });
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Bounded cache title" &&
          value.history.historyCursor === "cursor-oldest",
      );
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;

      const savedAll = yield* Ref.get(harness.savedThreads);
      expect(savedAll.length).toBeGreaterThanOrEqual(1);
      const first = savedAll[0];
      expect(first?.snapshotSequence).toBe(4);
      expect(first?.projection.thread.title).toBe("Bounded cache title");
      expect(first?.historyCursor).toBe("cursor-oldest");
      expect(first?.hasMoreHistory).toBe(true);
      expect(
        savedAll.some(
          (entry) =>
            entry.projection.thread.title === "Bounded cache title" &&
            entry.historyCursor === undefined &&
            entry.hasMoreHistory === undefined,
        ),
      ).toBe(false);

      yield* Queue.offer(harness.inputs, titleUpdated("Settled bounded", 5));
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Settled bounded",
      );
      yield* TestClock.adjust("10 seconds");
      yield* Effect.yieldNow;

      const saved = (yield* Ref.get(harness.savedThreads)).at(-1);
      expect(saved?.snapshotSequence).toBe(5);
      expect(saved?.projection.thread.title).toBe("Settled bounded");
      expect(saved?.historyCursor).toBe("cursor-oldest");
      expect(saved?.hasMoreHistory).toBe(true);
    }),
  );

  it.effect("warm resume restores progressive history meta and skips HTTP", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: {
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Cached bounded" },
        },
        cachedHistory: {
          historyCursor: "warm-cursor",
          hasMoreHistory: true,
        },
      });

      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Cached bounded live", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Cached bounded live" &&
          value.history.hasMoreHistory,
      );

      expect(state.history).toMatchObject({
        historyCursor: "warm-cursor",
        hasMoreHistory: true,
        expanded: false,
      });
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
      expect(yield* Ref.get(harness.lastAcceptBoundedSnapshot)).toBe(true);
    }),
  );

  it.effect.each(["disk", "retained"] as const)(
    "retains paging support through a complete bounded %s cache",
    (cacheKind) =>
      Effect.gen(function* () {
        const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
          snapshot: undefined,
          owner: undefined,
        };
        const cold = yield* Effect.scoped(
          Effect.gen(function* () {
            const harness = yield* makeHarness({
              resumeCache,
              httpSnapshot: {
                _tag: "present",
                snapshot: { snapshotSequence: 4, projection: BASE_PROJECTION },
                history: {
                  historyCursor: null,
                  hasMoreHistory: false,
                  latestLocalTurnOrdinal: null,
                },
              },
            });
            yield* Queue.offer(harness.inputs, titleUpdated("Complete bounded", 5));
            yield* awaitThreadState(
              harness.observed,
              (value) =>
                value.status === "live" &&
                Option.isSome(value.data) &&
                value.data.value.thread.title === "Complete bounded",
            );
            return harness;
          }),
        );
        const saved = (yield* Ref.get(cold.savedThreads)).at(-1);
        expect(saved).toMatchObject({
          snapshotSequence: 5,
          historyCursor: null,
          hasMoreHistory: false,
          latestLocalTurnOrdinal: null,
        });

        const warm = yield* makeHarness(
          cacheKind === "retained" ? { resumeCache } : { loadCached: Effect.succeedSome(saved!) },
        );
        yield* Queue.offer(warm.inputs, titleUpdated("Grown while closed", 200));
        yield* awaitThreadState(
          warm.observed,
          (value) =>
            value.status === "live" &&
            Option.isSome(value.data) &&
            value.data.value.thread.title === "Grown while closed",
        );
        expect(yield* Ref.get(warm.loaderCalls)).toBe(0);
        expect(yield* Ref.get(warm.lastSubscribeAfterSequence)).toBe(5);
        expect(yield* Ref.get(warm.lastAcceptBoundedSnapshot)).toBe(true);
      }),
  );

  it.effect.each(["no-http", "no-controller"] as const)(
    "does not negotiate bounded fallbacks with %s",
    (historyPaging) =>
      Effect.gen(function* () {
        for (const source of ["cache", "http"] as const) {
          const history = {
            historyCursor: "known-paging-cursor",
            hasMoreHistory: true,
          };
          const harness = yield* makeHarness({
            historyPaging,
            ...(source === "cache"
              ? { cached: BASE_PROJECTION, cachedHistory: history }
              : {
                  httpSnapshot: {
                    _tag: "present" as const,
                    snapshot: { snapshotSequence: 4, projection: BASE_PROJECTION },
                    history,
                  },
                }),
          });
          yield* Queue.offer(harness.inputs, titleUpdated("Paging unavailable", 10));
          yield* awaitThreadState(
            harness.observed,
            (value) =>
              value.status === "live" &&
              Option.isSome(value.data) &&
              value.data.value.thread.title === "Paging unavailable",
          );
          expect(yield* Ref.get(harness.lastAcceptBoundedSnapshot)).toBeUndefined();
        }
      }),
  );

  it.effect("bounded socket fallback replaces progressive history meta during resume", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: {
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Warm progressive" },
        },
        cachedHistory: {
          historyCursor: "stale-cursor",
          hasMoreHistory: true,
          latestLocalTurnOrdinal: 3,
        },
      });

      yield* Queue.offer(harness.inputs, {
        ...snapshot(
          {
            ...BASE_PROJECTION,
            thread: { ...BASE_PROJECTION.thread, title: "Bounded resume fallback" },
          },
          CACHED_SNAPSHOT_SEQUENCE + 1,
        ),
        historyCursor: "replacement-cursor",
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 9,
        payloadBudgetExceeded: false,
      });

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.getOrNull(value.data)?.thread.title === "Bounded resume fallback" &&
          value.history.historyCursor === "replacement-cursor",
      );

      expect(state.history).toMatchObject({
        historyCursor: "replacement-cursor",
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 9,
        expanded: false,
        loading: false,
        error: null,
      });
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
    }),
  );

  it.effect("live events preserve progressive history meta under atomic setThread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        httpSnapshot: {
          _tag: "present",
          snapshot: {
            snapshotSequence: 8,
            projection: {
              ...BASE_PROJECTION,
              thread: { ...BASE_PROJECTION.thread, title: "Bounded seed" },
            },
          },
          history: {
            historyCursor: "keep-me",
            hasMoreHistory: true,
          },
        },
      });

      yield* Queue.offer(harness.inputs, titleUpdated("Live preserves meta", 9));
      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Live preserves meta",
      );

      expect(state.history).toMatchObject({
        historyCursor: "keep-me",
        hasMoreHistory: true,
        expanded: false,
      });
    }),
  );

  it.effect("bounded HTTP install sets projection and progressive meta atomically", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        httpSnapshot: {
          _tag: "present",
          snapshot: {
            snapshotSequence: 2,
            projection: {
              ...BASE_PROJECTION,
              thread: { ...BASE_PROJECTION.thread, title: "Bounded atomic install" },
            },
          },
          history: {
            historyCursor: "post-install-cursor",
            hasMoreHistory: true,
          },
        },
      });

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Bounded atomic install" &&
          value.history.historyCursor === "post-install-cursor" &&
          value.history.hasMoreHistory === true,
      );

      expect(state.history).toMatchObject({
        historyCursor: "post-install-cursor",
        hasMoreHistory: true,
        loading: false,
        error: null,
        expanded: false,
      });
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(2);
    }),
  );

  it.effect("dropped partial-timeline turn item is a true applyItem no-op", () =>
    Effect.gen(function* () {
      const recent = {
        id: TurnItemId.make("item-window"),
        threadId: THREAD_ID,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 10,
        status: "completed" as const,
        title: null,
        startedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
        completedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
        updatedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
        type: "command_execution" as const,
        input: "pwd",
        output: "ok",
        exitCode: 0,
      } satisfies OrchestrationV2TurnItem;
      const recentRow = {
        position: 0,
        visibility: "local" as const,
        sourceThreadId: THREAD_ID,
        sourceItemId: recent.id,
        item: recent,
      };
      const boundedProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "Partial noop" },
        turnItems: [recent],
        visibleTurnItems: [recentRow],
      };
      const harness = yield* makeHarness({
        httpSnapshot: {
          _tag: "present",
          snapshot: {
            snapshotSequence: 5,
            projection: boundedProjection,
            latestLocalTurnOrdinal: 10,
          },
          history: {
            historyCursor: "partial-cursor",
            hasMoreHistory: true,
            latestLocalTurnOrdinal: 10,
          },
        },
      });

      const seeded = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Partial noop" &&
          value.history.historyCursor === "partial-cursor",
      );
      const seededProjection = Option.getOrThrow(seeded.data);
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;
      const savedBefore = (yield* Ref.get(harness.savedThreads)).length;

      const older = {
        ...recent,
        id: TurnItemId.make("item-old-outside"),
        ordinal: 3,
        output: "must-not-append",
      } satisfies OrchestrationV2TurnItem;
      yield* Queue.offer(harness.inputs, {
        kind: "event",
        sequence: 6,
        event: {
          id: EventId.make("event-old-partial"),
          type: "turn-item.updated",
          threadId: THREAD_ID,
          occurredAt: DateTime.makeUnsafe("2026-06-20T01:00:00.000Z"),
          payload: older,
        },
      });

      for (let attempt = 0; attempt < 30; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* Queue.offer(harness.inputs, titleUpdated("After dropped event", 7));
      const after = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "After dropped event",
      );

      expect(Option.getOrThrow(after.data).turnItems.map((item) => String(item.id))).toEqual([
        String(recent.id),
      ]);
      expect(after.history.latestLocalTurnOrdinal).toBe(10);
      const savedAfterDrop = (yield* Ref.get(harness.savedThreads)).length;
      expect(savedAfterDrop).toBe(savedBefore);
      expect(after.history.historyCursor).toBe("partial-cursor");
      expect(after.history.hasMoreHistory).toBe(true);
      expect(seededProjection.turnItems.map((item) => String(item.id))).toEqual([
        String(recent.id),
      ]);
    }),
  );

  it.effect("warm resume restores latestLocalTurnOrdinal from progressive cache", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: {
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Warm watermark" },
        },
        cachedHistory: {
          historyCursor: "warm-wm-cursor",
          hasMoreHistory: true,
          latestLocalTurnOrdinal: 33,
        },
      });

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Warm watermark" &&
          value.history.latestLocalTurnOrdinal === 33,
      );
      expect(state.history).toMatchObject({
        historyCursor: "warm-wm-cursor",
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 33,
        expanded: false,
      });
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
    }),
  );

  it.effect("marks a cold definitive HTTP miss deleted without socket subscribe or retry", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        httpSnapshot: { _tag: "missing" },
      });

      const state = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "deleted",
      );

      expect(Option.isNone(state.data)).toBe(true);
      expect(Option.isNone(state.error)).toBe(true);
      expect(yield* Ref.get(harness.loaderCalls)).toBeGreaterThanOrEqual(1);
      expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID]);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(0);

      yield* TestClock.adjust("1 second");
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* harness.replaceSession;
      yield* Queue.offer(harness.wakeups, "application-active");
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(0);
      expect(yield* Ref.get(harness.retryCount)).toBe(0);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(1);
      expect((yield* Ref.get(harness.latest)).status).toBe("deleted");
    }),
  );

  it.effect("falls back to the socket when the HTTP snapshot is only unavailable", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        httpSnapshot: { _tag: "unavailable" },
      });

      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Socket title" },
        }),
      );

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Socket title",
      );

      expect(Option.getOrThrow(state.data).thread.title).toBe("Socket title");
      expect(yield* Ref.get(harness.loaderCalls)).toBeGreaterThanOrEqual(1);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);
      expect(yield* Ref.get(harness.removedThreads)).toEqual([]);
    }),
  );

  it.effect("ignores replayed thread events at or below the snapshot sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* Queue.offer(harness.inputs, titleUpdated("Replayed title", 1));
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", 2));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Live title",
      );

      expect(Option.getOrThrow(state.data).thread.title).toBe("Live title");
    }),
  );

  it.effect("preserves data after a domain failure and resumes on a replacement session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* Queue.offer(harness.inputs, new Error("stream failed"));

      const state = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.error),
      );

      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
      expect(Option.getOrThrow(state.error)).toBe("stream failed");
      expect(yield* Ref.get(harness.retryCount)).toBe(0);

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Recovered thread" },
        }),
      );
      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Recovered thread",
      );

      expect(Option.isNone(recovered.error)).toBe(true);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
    }),
  );

  it.effect("recovers from a transient domain failure without replacing the session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Queue.offer(harness.inputs, new Error("thread not found yet"));

      const failed = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.error),
      );
      expect(Option.getOrThrow(failed.error)).toBe("thread not found yet");
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);

      yield* TestClock.adjust("250 millis");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Materialized thread" },
        }),
      );

      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Materialized thread",
      );

      expect(Option.isNone(recovered.error)).toBe(true);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.retryCount)).toBe(0);
    }),
  );

  it.effect("does not overwrite a live snapshot when the supervisor becomes ready", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 1,
        generation: 0,
        lastFailure: null,
        retryAt: null,
      });
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");

      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }

      expect((yield* Ref.get(harness.latest)).status).toBe("live");
    }),
  );

  it.effect("skips an unknown event type and resumes after it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION, completionMarker: true });
      const unknown = (sequence: number): OrchestrationV2ThreadStreamItem => ({
        kind: "unknown-event",
        sequence,
        eventType: "run.from-a-future-server",
      });
      const occurredAt = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
      yield* Queue.offerAll(harness.inputs, [
        {
          kind: "event",
          sequence: CACHED_SNAPSHOT_SEQUENCE + 1,
          event: {
            id: EventId.make("event-message"),
            type: "message.updated",
            threadId: THREAD_ID,
            occurredAt,
            payload: {
              id: MessageId.make("message-before"),
              threadId: THREAD_ID,
              runId: null,
              nodeId: null,
              role: "assistant",
              text: "Before",
              streaming: false,
              attachments: [],
              createdBy: "agent",
              creationSource: "provider",
              createdAt: occurredAt,
              updatedAt: occurredAt,
            },
          },
        },
        unknown(CACHED_SNAPSHOT_SEQUENCE + 2),
        titleUpdated("After", CACHED_SNAPSHOT_SEQUENCE + 3),
        unknown(CACHED_SNAPSHOT_SEQUENCE + 4),
        synchronized(),
      ]);
      const live = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "After",
      );
      expect(Option.isNone(live.error)).toBe(true);
      expect(Option.getOrThrow(live.data).messages.map((message) => message.text)).toEqual([
        "Before",
      ]);

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE + 4);
    }),
  );

  it.effect("resumes replacement sessions from the latest applied sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION, completionMarker: true });
      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Latest title", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Latest title",
      );

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE + 1);
      expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");
    }),
  );

  it.effect("resubscribes on app foreground from the latest applied sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION, completionMarker: true });
      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Latest title", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Latest title",
      );

      yield* Queue.offer(harness.wakeups, "application-active");
      const synchronizing = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }

      expect(synchronizing.status).toBe("synchronizing");
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE + 1);
      expect(yield* Ref.get(harness.lastRequestCompletionMarker)).toBe(true);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);

      yield* Queue.offer(harness.inputs, synchronized());
      const live = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      expect(Option.getOrThrow(live.data).thread.title).toBe("Latest title");

      yield* Queue.offer(harness.wakeups, "application-active-probe");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 3) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(3);

      yield* Queue.offer(harness.wakeups, "application-active-reconnect");
      for (let attempt = 0; attempt < 10; attempt += 1) {
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(3);
    }),
  );
});
