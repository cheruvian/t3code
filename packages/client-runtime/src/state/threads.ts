import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type OrchestrationAssistantPreview,
  type OrchestrationThread,
  type OrchestrationThreadDetailPage,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  type ThreadId as ThreadIdType,
  type TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { subscribeDynamic } from "../rpc/client.ts";
import { ThreadSnapshotLoader, type ThreadSnapshotWindow } from "./threadSnapshotHttp.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { applyThreadDetailEvent } from "./threadReducer.ts";
import { orderThreadActivities } from "./threadActivity.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadPageState,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
} from "./threadState.ts";

function statusWithoutLiveData(data: Option.Option<OrchestrationThread>): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

/**
 * Turn window sizes for paginated thread loads: the initial page covers the
 * last 10 user-anchored turns (subagent/fan-out turns ride along), each
 * "load earlier" tap fetches 20 more. Sized so first paint on the heaviest
 * observed threads stays around 100K gzipped while median threads load fully.
 */
export const INITIAL_THREAD_USER_TURN_LIMIT = 10;
export const OLDER_THREAD_PAGE_USER_TURN_LIMIT = 20;

function pageStateFromSnapshot(
  page: OrchestrationThreadDetailPage | undefined,
): Option.Option<EnvironmentThreadPageState> {
  return page === undefined
    ? Option.none()
    : Option.some({
        beforeCursor: page.beforeCursor,
        hasMore: page.hasMore,
        loadingOlder: false,
      });
}

interface ThreadOlderTurnRequestRegistry {
  /**
   * Registers the live state machine for a thread. Returns the deregistration
   * cleanup; registration lives exactly as long as the machine's scope, and a
   * successor machine for the same thread simply replaces the entry.
   */
  readonly register: (key: string, handler: () => void) => () => void;
  readonly request: (key: string) => boolean;
}

function makeThreadOlderTurnRequestRegistry(): ThreadOlderTurnRequestRegistry {
  const handlers = new Map<string, () => void>();
  return {
    register: (key, handler) => {
      handlers.set(key, handler);
      return () => {
        if (handlers.get(key) === handler) {
          handlers.delete(key);
        }
      };
    },
    request: (key) => {
      const handler = handlers.get(key);
      if (handler === undefined) {
        return false;
      }
      handler();
      return true;
    },
  };
}

const defaultOlderTurnRequestRegistry = makeThreadOlderTurnRequestRegistry();

/**
 * Channel from UI actions to the live per-thread state machines. The machines
 * resolve it from the Effect environment (overridable in tests); the default
 * instance is shared with the sync `requestOlderThreadTurns` entry point so
 * the apps get working wiring without providing anything.
 */
export class ThreadOlderTurnRequests extends Context.Reference<ThreadOlderTurnRequestRegistry>(
  "@t3tools/client-runtime/state/threads/ThreadOlderTurnRequests",
  { defaultValue: () => defaultOlderTurnRequestRegistry },
) {}

/**
 * Asks the live state machine for `threadId` to fetch the next older page.
 * Returns false when no machine is live or no fetch was started (no cursor,
 * already loading); callers render from `EnvironmentThreadState.page` and can
 * treat false as "nothing to do".
 */
export function requestOlderThreadTurns(
  environmentId: EnvironmentIdType,
  threadId: ThreadIdType,
): boolean {
  return defaultOlderTurnRequestRegistry.request(threadKey({ environmentId, threadId }));
}

function formatThreadError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not synchronize the thread.";
}

function shouldPersistThread(thread: OrchestrationThread): boolean {
  const status = thread.session?.status;
  return status !== "starting" && status !== "running";
}

function threadWithAssistantPreview(
  thread: OrchestrationThread,
  preview: Option.Option<OrchestrationAssistantPreview>,
): OrchestrationThread {
  if (
    Option.isNone(preview) ||
    thread.messages.some((message) => message.id === preview.value.messageId)
  ) {
    return thread;
  }

  return {
    ...thread,
    messages: [
      ...thread.messages,
      {
        id: preview.value.messageId,
        role: "assistant",
        text: preview.value.text,
        turnId: preview.value.turnId,
        streaming: true,
        createdAt: preview.value.createdAt,
        updatedAt: preview.value.createdAt,
      },
    ],
  };
}

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const snapshotLoader = yield* ThreadSnapshotLoader;
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const environmentId = supervisor.target.environmentId;
  const cached = yield* cache.loadThread(environmentId, threadId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached thread.").pipe(
        Effect.annotateLogs({
          environmentId,
          threadId,
          error: error.message,
        }),
        Effect.as(Option.none<OrchestrationThreadDetailSnapshot>()),
      ),
    ),
  );
  const cachedThread = Option.map(cached, (snapshot) => snapshot.thread);
  // The durable thread remains preview-free for reducers, pagination, and
  // persistence. `state` is the rendered projection that may temporarily add
  // one live assistant preview on top.
  const durableThread = yield* Ref.make(cachedThread);
  const assistantPreview = yield* Ref.make<Option.Option<OrchestrationAssistantPreview>>(
    Option.none(),
  );
  const blockedPreviewTurnIds = yield* Ref.make<ReadonlySet<TurnId>>(new Set());
  const state = yield* SubscriptionRef.make<EnvironmentThreadState>({
    data: cachedThread,
    status: statusWithoutLiveData(cachedThread),
    error: Option.none(),
    // A cached windowed snapshot restores its page cursor so "load earlier"
    // works while rendering from cache; a cached full snapshot has no page.
    page: Option.flatMap(cached, (snapshot) => pageStateFromSnapshot(snapshot.page)),
  });
  // Seed the resume cursor from the cached snapshot so a warm cache can catch up
  // via `afterSequence` instead of re-downloading the full thread body.
  const lastSequence = yield* SubscriptionRef.make(
    Option.match(cached, { onNone: () => 0, onSome: (snapshot) => snapshot.snapshotSequence }),
  );
  const awaitingCompletion = yield* Ref.make(false);
  // Bumped whenever loaded history may have been rewritten out from under an
  // in-flight older-page fetch (snapshot replacement, revert, deletion). A
  // page response captured under an older epoch is discarded, not merged.
  const historyEpoch = yield* Ref.make(0);
  // Serializes stream-item application against older-page staleness checks +
  // merges. Without it, a revert or snapshot processed between loadOlderTurns'
  // epoch check and its merge could still slip resurrected history in.
  const applyLock = yield* Semaphore.make(1);
  // Whether the connected server accepts windowed reads; set per subscription
  // from the session config. Gates loadOlderTurns so a reconnect to a
  // pre-pagination server never sends unsupported window parameters.
  const paginationSupported = yield* Ref.make(false);
  // An older page whose thread watermark is ahead of the live state, parked
  // until the subscription catches up (see mergeOlderPage's caller). At most
  // one can exist because loadOlderTurns no-ops while loadingOlder is true.
  const pendingOlderPage = yield* Ref.make<{
    readonly snapshot: OrchestrationThreadDetailSnapshot;
    readonly epoch: number;
  } | null>(null);
  const persistence = yield* Queue.sliding<OrchestrationThreadDetailSnapshot>(1);

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    snapshot: OrchestrationThreadDetailSnapshot,
  ) {
    yield* cache.saveThread(environmentId, snapshot).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not persist the thread cache.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  yield* Stream.fromQueue(persistence).pipe(
    Stream.debounce("500 millis"),
    Stream.runForEach(persist),
    Effect.forkScoped,
  );

  const renderDurableData = Effect.fn("EnvironmentThreadState.renderDurableData")(function* () {
    const [durable, preview] = yield* Effect.all([
      Ref.get(durableThread),
      Ref.get(assistantPreview),
    ]);
    const rendered = Option.map(durable, (thread) => threadWithAssistantPreview(thread, preview));
    yield* SubscriptionRef.update(state, (current) => ({ ...current, data: rendered }));
  });

  const blockPreviewTurn = (turnId: TurnId) =>
    Ref.update(blockedPreviewTurnIds, (current) => {
      const next = new Set(current);
      next.add(turnId);
      return next;
    });

  const clearAssistantPreview = Effect.fn("EnvironmentThreadState.clearAssistantPreview")(
    function* (options?: { readonly blockCurrentTurn?: boolean }) {
      const current = yield* Ref.get(assistantPreview);
      if (options?.blockCurrentTurn === true && Option.isSome(current)) {
        yield* blockPreviewTurn(current.value.turnId);
      }
      yield* Ref.set(assistantPreview, Option.none());
      yield* renderDurableData();
    },
  );

  const resetAssistantPreviews = Effect.fn("EnvironmentThreadState.resetAssistantPreviews")(
    function* () {
      yield* Ref.set(blockedPreviewTurnIds, new Set());
      yield* Ref.set(assistantPreview, Option.none());
      yield* renderDurableData();
    },
  );

  const setSynchronizing = SubscriptionRef.update(state, (current) =>
    current.status === "deleted"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live" || current.status === "deleted"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setDisconnected = Effect.gen(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* resetAssistantPreviews();
    // The capability belongs to the session that advertised it. During a
    // reconnect, a new prepared connection can exist before the new session's
    // config arrives; leaving the old value would let loadOlderTurns send
    // window parameters to a server that may not accept them (review
    // finding). makeSubscribeInput re-sets it from the next session's config.
    yield* Ref.set(paginationSupported, false);
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
    }));
  });
  const setStreamError = (cause: Cause.Cause<unknown>) =>
    Effect.gen(function* () {
      yield* Ref.set(awaitingCompletion, false);
      yield* resetAssistantPreviews();
      yield* SubscriptionRef.update(state, (current) => ({
        ...current,
        status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
        error: Option.some(formatThreadError(cause)),
      }));
    });

  const setThread = Effect.fn("EnvironmentThreadState.setThread")(function* (
    thread: OrchestrationThread,
    // "keep" preserves the current page state (live events touch only loaded
    // recent turns); a snapshot or merged page passes its own page state.
    page: Option.Option<EnvironmentThreadPageState> | "keep",
  ) {
    yield* Ref.set(durableThread, Option.some(thread));
    const currentPreview = yield* Ref.get(assistantPreview);
    if (
      Option.isSome(currentPreview) &&
      thread.messages.some((message) => message.id === currentPreview.value.messageId)
    ) {
      yield* Ref.set(assistantPreview, Option.none());
    }
    const preview = yield* Ref.get(assistantPreview);
    const waiting = yield* Ref.get(awaitingCompletion);
    yield* SubscriptionRef.update(state, (current) => ({
      data: Option.some(threadWithAssistantPreview(thread, preview)),
      status: waiting ? ("synchronizing" as const) : ("live" as const),
      error: Option.none(),
      page: page === "keep" ? current.page : page,
    }));
    // Active threads can update many times per second and retain large tool
    // payloads. The server remains the source of truth while a turn is active;
    // persist once it settles so cache encoding stays off the streaming path.
    if (shouldPersistThread(thread)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      const currentPage = yield* SubscriptionRef.get(state).pipe(Effect.map((value) => value.page));
      yield* Queue.offer(persistence, {
        snapshotSequence,
        thread,
        // Persist the window boundary with the window's content so a cache
        // restore can keep paging from where the loaded history ends.
        ...Option.match(currentPage, {
          onNone: () => ({}),
          onSome: (value) =>
            ({
              page: {
                beforeCursor: value.beforeCursor,
                hasMore: value.hasMore,
                snapshotSequence,
              },
            }) as const,
        }),
      });
    }
  });

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* Ref.update(historyEpoch, (epoch) => epoch + 1);
    yield* Ref.set(durableThread, Option.none());
    yield* Ref.set(assistantPreview, Option.none());
    yield* Ref.set(blockedPreviewTurnIds, new Set());
    yield* SubscriptionRef.set(state, {
      data: Option.none(),
      status: "deleted",
      error: Option.none(),
      page: Option.none(),
    });
    yield* cache.removeThread(environmentId, threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not remove the cached thread.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  const applyAssistantPreview = Effect.fn("EnvironmentThreadState.applyAssistantPreview")(
    function* (preview: OrchestrationAssistantPreview) {
      if (preview.text.trim().length === 0) {
        return;
      }
      const [durable, blockedTurns] = yield* Effect.all([
        Ref.get(durableThread),
        Ref.get(blockedPreviewTurnIds),
      ]);
      if (
        Option.isNone(durable) ||
        blockedTurns.has(preview.turnId) ||
        durable.value.messages.some((message) => message.id === preview.messageId)
      ) {
        return;
      }

      yield* Ref.set(assistantPreview, Option.some(preview));
      yield* renderDurableData();
    },
  );

  // Body of applyItem, running under applyLock.
  const applyItemLocked = Effect.fn("EnvironmentThreadState.applyItemLocked")(function* (
    item: OrchestrationThreadStreamItem,
  ) {
    if (item.kind === "assistant-preview") {
      yield* applyAssistantPreview(item);
      return;
    }

    if (item.kind === "synchronized") {
      yield* Ref.set(awaitingCompletion, false);
      yield* SubscriptionRef.update(state, (current) =>
        Option.isSome(current.data) && current.status !== "deleted"
          ? { ...current, status: "live" as const, error: Option.none() }
          : current,
      );
      return;
    }

    if (item.kind === "snapshot") {
      // A fresh snapshot replaces all loaded history, including older
      // pages: a turn reverted while disconnected would otherwise survive
      // in the preserved history with no event left to remove it. The
      // epoch bump discards any older-page fetch racing this snapshot.
      yield* Ref.update(historyEpoch, (epoch) => epoch + 1);
      yield* SubscriptionRef.set(lastSequence, item.snapshot.snapshotSequence);
      yield* setThread(item.snapshot.thread, pageStateFromSnapshot(item.snapshot.page));
      return;
    }

    const sequence = yield* SubscriptionRef.get(lastSequence);
    if (item.event.sequence <= sequence) {
      return;
    }
    yield* SubscriptionRef.set(lastSequence, item.event.sequence);

    const current = yield* Ref.get(durableThread);
    if (Option.isNone(current)) {
      if (item.event.type === "thread.deleted") {
        yield* setDeleted();
      }
      return;
    }
    if (item.event.type === "thread.reverted") {
      // A revert rewrites loaded history (whole turns disappear), so an
      // older-page fetch in flight may straddle the removed range; the epoch
      // bump discards it. The stored page cursor stays valid: cursors are an
      // (anchor, turnId) keyset derived from event content, which survives
      // the revert projector's row rewrite, so no refresh is needed — the
      // revert reducer's turn filtering fully handles loaded history.
      yield* Ref.update(historyEpoch, (epoch) => epoch + 1);
      yield* clearAssistantPreview({ blockCurrentTurn: true });
    }
    if (item.event.type === "thread.message-sent" && item.event.payload.role === "assistant") {
      const preview = yield* Ref.get(assistantPreview);
      if (Option.isSome(preview) && preview.value.messageId === item.event.payload.messageId) {
        yield* Ref.set(assistantPreview, Option.none());
      }
    }
    if (item.event.type === "thread.session-set") {
      const preview = yield* Ref.get(assistantPreview);
      const previousActiveTurnId = current.value.session?.activeTurnId;
      const nextSession = item.event.payload.session;
      const remainsActive = nextSession.status === "starting" || nextSession.status === "running";
      if (!remainsActive && previousActiveTurnId !== null && previousActiveTurnId !== undefined) {
        yield* blockPreviewTurn(previousActiveTurnId);
      }
      if (
        Option.isSome(preview) &&
        (!remainsActive || nextSession.activeTurnId !== preview.value.turnId)
      ) {
        yield* blockPreviewTurn(preview.value.turnId);
        yield* Ref.set(assistantPreview, Option.none());
      }
    }
    const result = applyThreadDetailEvent(current.value, item.event);
    if (result.kind === "updated") {
      yield* setThread(result.thread, "keep");
    } else if (result.kind === "deleted") {
      yield* setDeleted();
    }
    // The event may have advanced the live state past a parked page's
    // watermark; merge it as soon as that happens.
    yield* tryMergePendingOlderPage();
  });

  // Merges a parked older page once the live state has caught up to the
  // page's thread watermark, or discards it if history was rewritten
  // (epoch advanced) while it waited. Must run under applyLock.
  const tryMergePendingOlderPage = Effect.fn("EnvironmentThreadState.tryMergePendingOlderPage")(
    function* () {
      const pending = yield* Ref.get(pendingOlderPage);
      if (pending === null) {
        return;
      }
      const epochNow = yield* Ref.get(historyEpoch);
      if (epochNow !== pending.epoch) {
        yield* Ref.set(pendingOlderPage, null);
        yield* SubscriptionRef.update(state, (value) => ({
          ...value,
          page: Option.map(value.page, (existing) => ({ ...existing, loadingOlder: false })),
        }));
        return;
      }
      const watermark = pending.snapshot.page?.threadSequence;
      const loadedSequence = yield* SubscriptionRef.get(lastSequence);
      if (watermark !== undefined && watermark > loadedSequence) {
        return;
      }
      yield* Ref.set(pendingOlderPage, null);
      yield* mergeOlderPage(pending.snapshot);
    },
  );

  const applyItem = Effect.fn("EnvironmentThreadState.applyItem")(function* (
    item: OrchestrationThreadStreamItem,
  ) {
    yield* applyLock.withPermits(1)(applyItemLocked(item));
  });

  // Merges an older disjoint page below the currently loaded window. All four
  // windowed collections prepend; identity dedupe guards the (server-bug or
  // cursor-misuse) case of overlapping pages so a row never renders twice.
  const mergeOlderPage = Effect.fn("EnvironmentThreadState.mergeOlderPage")(function* (
    snapshot: OrchestrationThreadDetailSnapshot,
  ) {
    const durable = yield* Ref.get(durableThread);
    if (Option.isNone(durable)) {
      return;
    }
    const loaded = durable.value;
    const older = snapshot.thread;
    const mergeById = <T extends { readonly id: string }>(
      olderRows: ReadonlyArray<T>,
      loadedRows: ReadonlyArray<T>,
    ): ReadonlyArray<T> => {
      const seen = new Set(loadedRows.map((row) => row.id));
      return [...olderRows.filter((row) => !seen.has(row.id)), ...loadedRows];
    };
    const seenCheckpoints = new Set(loaded.checkpoints.map((row) => row.turnId));
    const merged: OrchestrationThread = {
      // Thread metadata stays the loaded (newer) snapshot's; only the
      // windowed collections gain rows from the older page.
      ...loaded,
      messages: mergeById(older.messages, loaded.messages),
      activities: orderThreadActivities(mergeById(older.activities, loaded.activities)),
      proposedPlans: mergeById(older.proposedPlans, loaded.proposedPlans),
      checkpoints: [
        ...older.checkpoints.filter((row) => !seenCheckpoints.has(row.turnId)),
        ...loaded.checkpoints,
      ],
    };
    yield* Ref.set(durableThread, Option.some(merged));
    const preview = yield* Ref.get(assistantPreview);
    yield* SubscriptionRef.update(state, (value) => ({
      ...value,
      data: Option.some(threadWithAssistantPreview(merged, preview)),
      page: pageStateFromSnapshot(snapshot.page),
    }));
    // Persist the widened window under the *loaded* watermark: the merged
    // content is only known consistent with the state it merged into, not
    // with the page's own (possibly newer) sequence.
    if (shouldPersistThread(merged)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      yield* Queue.offer(persistence, {
        snapshotSequence,
        thread: merged,
        ...(snapshot.page === undefined ? {} : { page: { ...snapshot.page, snapshotSequence } }),
      });
    }
  });

  const loadOlderTurns = Effect.fn("EnvironmentThreadState.loadOlderTurns")(function* () {
    // Gated on the connected server's capability: a reconnect to a
    // pre-pagination server must never receive window parameters.
    if (!(yield* Ref.get(paginationSupported))) {
      return;
    }
    const current = yield* SubscriptionRef.get(state);
    const page = Option.getOrNull(current.page);
    if (page === null || page.loadingOlder || !page.hasMore || page.beforeCursor === null) {
      return;
    }
    const prepared = Option.getOrNull(yield* SubscriptionRef.get(supervisor.prepared));
    if (prepared === null) {
      return;
    }
    const epochAtStart = yield* Ref.get(historyEpoch);
    yield* SubscriptionRef.update(state, (value) => ({
      ...value,
      page: Option.map(value.page, (existing) => ({ ...existing, loadingOlder: true })),
    }));
    const window: ThreadSnapshotWindow = {
      turnLimit: OLDER_THREAD_PAGE_USER_TURN_LIMIT,
      beforeCursor: page.beforeCursor,
    };
    const response = yield* snapshotLoader.load(prepared, threadId, window);
    // Staleness check and merge run under the same lock as stream-item
    // application, so a revert/snapshot cannot land between them (TOCTOU
    // review finding) — anything that rewrites history bumps the epoch
    // before this permit is acquired.
    yield* applyLock.withPermits(1)(
      Effect.gen(function* () {
        const epochNow = yield* Ref.get(historyEpoch);
        const loadedSequence = yield* SubscriptionRef.get(lastSequence);
        // A page carrying a sequence older than the loaded state was read
        // from a projection behind what we render; merging it could
        // resurrect turns a newer snapshot or revert already removed.
        const stale =
          epochNow !== epochAtStart ||
          Option.match(response, {
            onNone: () => false,
            onSome: (snapshot) => snapshot.snapshotSequence < loadedSequence,
          });
        if (Option.isNone(response) || stale) {
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            page: Option.map(value.page, (existing) => ({ ...existing, loadingOlder: false })),
          }));
          return;
        }
        // A page read AHEAD of the live state may include content (e.g.
        // streaming deltas of an out-of-window turn) the subscription has
        // not delivered yet; merging now and then replaying those events
        // would duplicate them. Park the page until the live state reaches
        // the page's thread-scoped watermark; loadingOlder stays true so
        // the UI shows progress and no second fetch starts. Pages from
        // pre-watermark servers (threadSequence absent) merge immediately,
        // preserving the old behavior.
        const watermark = response.value.page?.threadSequence;
        if (watermark !== undefined && watermark > loadedSequence) {
          yield* Ref.set(pendingOlderPage, {
            snapshot: response.value,
            epoch: epochNow,
          });
          return;
        }
        yield* mergeOlderPage(response.value);
      }),
    );
  });

  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      switch (connectionProjectionPhase(connectionState)) {
        case "synchronizing":
          return setSynchronizing;
        case "disconnected":
          return setDisconnected;
        case "ready":
          return setReady;
      }
    }),
    Effect.forkScoped,
  );

  const foregroundResubscriptions = Option.match(wakeups, {
    onNone: () => Stream.never,
    onSome: (service) =>
      service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
  });

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    subscribeDynamic(
      ORCHESTRATION_WS_METHODS.subscribeThread,
      Effect.fn("EnvironmentThreadState.makeSubscribeInput")(function* (session) {
        const config = yield* session.initialConfig.pipe(
          Effect.orElseSucceed(
            () =>
              ({}) as {
                threadResumeCompletionMarker?: boolean;
                threadSnapshotPagination?: boolean;
                assistantPreviews?: true;
              },
          ),
        );
        const supportsCompletionMarker = config.threadResumeCompletionMarker === true;
        const supportsAssistantPreviews = config.assistantPreviews === true;
        // Windowed loads are gated on the server capability: pre-pagination
        // servers reject unknown query params, and a windowed WS fallback to
        // such a server would silently hide history.
        const supportsPagination = config.threadSnapshotPagination === true;
        yield* resetAssistantPreviews();
        yield* Ref.set(paginationSupported, supportsPagination);
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
        yield* setSynchronizing;

        let current = yield* SubscriptionRef.get(state);
        // A windowed cache resuming against a server without pagination is a
        // trap: afterSequence resume keeps only the window, and the missing
        // older turns can never be loaded (the server has no cursor reads).
        // Drop the window marker and treat the data as needing a full reload.
        if (!supportsPagination && Option.isSome(current.page)) {
          yield* Ref.update(historyEpoch, (epoch) => epoch + 1);
          yield* Ref.set(durableThread, Option.none());
          yield* Ref.set(assistantPreview, Option.none());
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            data: Option.none(),
            status: value.status === "deleted" ? value.status : ("empty" as const),
            page: Option.none(),
          }));
          yield* SubscriptionRef.set(lastSequence, 0);
          current = yield* SubscriptionRef.get(state);
        }
        if (Option.isNone(current.data) && current.status !== "deleted") {
          const prepared = yield* SubscriptionRef.get(supervisor.prepared).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  SubscriptionRef.changes(supervisor.prepared).pipe(
                    Stream.filter(Option.isSome),
                    Stream.map((value) => value.value),
                    Stream.runHead,
                    Effect.map(Option.getOrThrow),
                  ),
              }),
            ),
          );
          const httpSnapshot = yield* snapshotLoader.load(
            prepared,
            threadId,
            supportsPagination ? { turnLimit: INITIAL_THREAD_USER_TURN_LIMIT } : undefined,
          );
          if (Option.isSome(httpSnapshot)) {
            yield* applyItem({ kind: "snapshot", snapshot: httpSnapshot.value });
            current = yield* SubscriptionRef.get(state);
          }
        }

        const sequence = yield* SubscriptionRef.get(lastSequence);
        const canResume = Option.isSome(current.data);
        if (!supportsCompletionMarker && canResume) {
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            status: value.status === "deleted" ? value.status : ("live" as const),
            error: Option.none(),
          }));
        }

        return {
          threadId,
          ...(canResume ? { afterSequence: sequence } : {}),
          ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
          ...(supportsAssistantPreviews ? { includeAssistantPreviews: true as const } : {}),
          // The WS fallback snapshot (sent when afterSequence is missing or
          // the gap is too large) should be windowed the same as the HTTP
          // path; without this a resume failure re-downloads the full thread.
          ...(supportsPagination ? { turnLimit: INITIAL_THREAD_USER_TURN_LIMIT } : {}),
        };
      }),
      {
        onExpectedFailure: setStreamError,
        retryExpectedFailureAfter: "250 millis",
        resubscribe: foregroundResubscriptions,
      },
    ).pipe(Stream.runForEach(applyItem)),
  );

  // Expose loadOlderTurns to UI actions through the request registry.
  // Requests funnel through a sliding queue drained serially, so mashing
  // "load earlier" coalesces (loadOlderTurns itself no-ops while a fetch is
  // in flight).
  const olderTurnRequestRegistry = yield* ThreadOlderTurnRequests;
  const olderTurnRequests = yield* Queue.sliding<void>(1);
  yield* Stream.fromQueue(olderTurnRequests).pipe(
    Stream.runForEach(() => loadOlderTurns()),
    Effect.forkScoped,
  );
  const deregister = olderTurnRequestRegistry.register(
    threadKey({ environmentId, threadId }),
    () => {
      Queue.offerUnsafe(olderTurnRequests, undefined);
    },
  );
  yield* Effect.addFinalizer(() => Effect.sync(deregister));

  yield* Effect.addFinalizer(() =>
    Effect.all([
      SubscriptionRef.get(state),
      Ref.get(durableThread),
      SubscriptionRef.get(lastSequence),
    ]).pipe(
      Effect.flatMap(([current, durable, snapshotSequence]) =>
        Option.match(durable, {
          onNone: () => Effect.void,
          onSome: (thread) =>
            shouldPersistThread(thread)
              ? persist({
                  snapshotSequence,
                  thread,
                  ...Option.match(current.page, {
                    onNone: () => ({}),
                    onSome: (page) =>
                      ({
                        page: {
                          beforeCursor: page.beforeCursor,
                          hasMore: page.hasMore,
                          snapshotSequence,
                        },
                      }) as const,
                  }),
                })
              : Effect.void,
        }),
      ),
    ),
  );

  return state;
});

export function threadStateChanges(environmentId: EnvironmentIdType, threadId: ThreadIdType) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(makeEnvironmentThreadState(threadId).pipe(Effect.map(SubscriptionRef.changes))),
  );
}

export function createEnvironmentThreadStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader | R,
    E
  >,
) {
  const family = Atom.family((key: string) => {
    const { environmentId, threadId } = parseThreadKey(key);
    return runtime
      .atom(threadStateChanges(environmentId, threadId), {
        initialValue: EMPTY_ENVIRONMENT_THREAD_STATE,
      })
      .pipe(
        Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
        Atom.withLabel(`environment-thread-state:${key}`),
      );
  });

  return {
    stateAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      family(threadKey({ environmentId, threadId })),
  };
}

export * from "./archivedThreads.ts";
export * from "./checkpointDiff.ts";
export * from "./threadSnapshotHttp.ts";
export * from "./composerPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadFeedback.ts";
export * from "./threadDetail.ts";
export * from "./threadReducer.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";
