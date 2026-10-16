import * as AssistantPreviewBus from "./orchestration-v2/AssistantPreviewBus.ts";
import * as DateTime from "effect/DateTime";
import * as CommandReceiptStore from "./orchestration-v2/CommandReceiptStore.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "./orchestration-v2/ThreadCommandExecutor.ts";
import { assert, it } from "@effect/vitest";
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  ProviderInstanceId,
  EventId,
  MessageId,
  ProviderSessionId,
  TurnItemId,
  type OrchestrationV2AssistantMessageItem,
  ProjectId,
  ThreadId,
  type OrchestrationV2StoredEvent,
  type OrchestrationProjectShell,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ApplicationStoredEvent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";

import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventStore from "./orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "./orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";

import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ProjectEnrichment from "./project/ProjectEnrichmentService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import {
  hasCompatibleOrchestrationProtocol,
  resolveAvailableEditorsForConfig,
  shouldUseBoundedThreadSnapshot,
  subscribeOrchestrationV2Shell,
  subscribeOrchestrationV2Thread,
  withLateEditorConfig,
} from "./ws.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";

import * as ProjectEnrichmentService from "./project/ProjectEnrichmentService.ts";
import * as ServerSettings from "./serverSettings.ts";

it.effect(
  "shares live shell projections between clients and delivers newer state without delay",
  () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<ApplicationStoredEvent>();
      const enrichment = yield* PubSub.unbounded<never>();
      const attached = yield* Deferred.make<void>();
      let subscribers = 0;
      let reads = 0;
      let title = "first";
      const threadId = ThreadId.make("thread:shared-ws-shell");
      const dependencies = Layer.mergeAll(
        ServerSettings.layerTest(),
        SqlitePersistence.layerMemory,
        Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
          subscribeChanges: PubSub.subscribe(enrichment),
        }),
        Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
          latestApplicationSequence: Effect.succeed(0),
          streamProjectedApplicationEvents: (input) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const subscription = yield* PubSub.subscribe(events);
                if (++subscribers === 2) yield* Deferred.succeed(attached, undefined);
                return Stream.fromSubscription(subscription).pipe(Stream.map(input.project));
              }),
            ),
        }),
        ThreadManagementService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({}),
              Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
              Layer.mock(ThreadCommandExecutor.ThreadCommandExecutor)({}),
              ServerSettings.layerTest(),
            ),
          ),
          Layer.provide(
            Layer.mock(Orchestrator.OrchestratorV2)({
              readShellSnapshot: () =>
                Effect.succeed(
                  Effect.succeed({
                    schemaVersion: 1,
                    snapshotSequence: 0,
                    threads: [],
                    archivedThreads: [],
                  }),
                ),
              getThreadShell: () =>
                Effect.sync(() => {
                  reads++;
                  return { id: threadId, title, archivedAt: null } as OrchestrationV2ThreadShell;
                }),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const outputs = [yield* Queue.unbounded<string>(), yield* Queue.unbounded<string>()];
        for (const output of outputs) {
          yield* Effect.gen(function* () {
            const stream = yield* subscribeOrchestrationV2Shell({});
            yield* Stream.runForEach(stream, (item) =>
              item.kind === "thread.updated"
                ? Queue.offer(output, item.thread.title).pipe(Effect.asVoid)
                : Effect.void,
            );
          }).pipe(Effect.forkScoped);
        }
        yield* Deferred.await(attached);
        const event = (sequence: number, type: string, payload: object) =>
          ({
            sequence,
            event: { threadId, type, payload },
          }) as ApplicationStoredEvent;
        yield* PubSub.publishAll(events, [
          event(1, "node.updated", { kind: "reasoning", status: "running" }),
          event(2, "turn-item.updated", { type: "reasoning", status: "running" }),
          event(3, "message.updated", { role: "assistant", streaming: true }),
          event(4, "run.updated", { status: "completed" }),
        ]);
        yield* TestClock.adjust("50 millis");
        for (const output of outputs) assert.strictEqual(yield* Queue.take(output), "first");
        assert.strictEqual(reads, 1);
        title = "newer";
        yield* PubSub.publish(events, event(5, "thread.metadata-updated", {}));
        yield* TestClock.adjust("50 millis");
        for (const output of outputs) assert.strictEqual(yield* Queue.take(output), "newer");
        assert.strictEqual(reads, 2);
      }).pipe(Effect.provide(dependencies));
    }),
);

it("accepts only the current orchestration protocol before websocket RPC setup", () => {
  assert.isTrue(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`),
    ),
  );
  assert.isFalse(hasCompatibleOrchestrationProtocol(new URL("https://host.test/ws")));
  assert.isFalse(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION - 1}`),
    ),
  );
});

it("keeps full thread snapshot fallback unless the client opts into bounded history", () => {
  assert.isFalse(shouldUseBoundedThreadSnapshot({}));
  assert.isFalse(shouldUseBoundedThreadSnapshot({ acceptBoundedSnapshot: false }));
  assert.isTrue(shouldUseBoundedThreadSnapshot({ acceptBoundedSnapshot: true }));
});

it.effect("does not block server config when editor discovery never resolves", () =>
  Effect.gen(function* () {
    const discoveryInterrupted = yield* Deferred.make<void>();
    const responseFiber = yield* resolveAvailableEditorsForConfig(
      Effect.never.pipe(
        Effect.onInterrupt(() => Deferred.succeed(discoveryInterrupted, undefined)),
      ),
    ).pipe(Effect.forkChild);

    yield* TestClock.adjust(Duration.seconds(5));

    const availableEditors = yield* Fiber.join(responseFiber);
    yield* Deferred.await(discoveryInterrupted);
    assert.deepEqual(availableEditors, []);
  }),
);

const snapshotConfig = (fields: Partial<ServerConfig>) =>
  ({ availableEditors: [], settings: {}, ...fields }) as unknown as ServerConfig;

const settingsUpdated = (settings: object): ServerConfigStreamEvent => ({
  version: 1,
  type: "settingsUpdated",
  payload: { settings: settings as ServerConfig["settings"] },
});

it.effect("resends late editors without rolling back updates already sent", () =>
  Effect.gen(function* () {
    const settingsSent = yield* Deferred.make<void>();
    const events = yield* withLateEditorConfig(
      snapshotConfig({ settings: { enableProviderUpdateChecks: true } as never }),
      Stream.make(settingsUpdated({ enableProviderUpdateChecks: false })),
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: () =>
          Deferred.await(settingsSent).pipe(Effect.as("file-explorer" as const)),
      },
    ).pipe(
      Stream.tap((event) =>
        event.type === "settingsUpdated" ? Deferred.succeed(settingsSent, undefined) : Effect.void,
      ),
      Stream.runCollect,
    );

    const [first, second] = Array.from(events);
    assert.equal(events.length, 2);
    assert.equal(first?.type, "settingsUpdated");
    assert.equal(second?.type, "snapshot");
    if (second?.type === "snapshot") {
      assert.deepEqual(second.config.availableEditors, ["file-manager"]);
      assert.equal(second.config.shellRevealInFileManagerKind, "file-explorer");
      assert.deepEqual(second.config.settings, { enableProviderUpdateChecks: false } as never);
    }
  }),
);

it.effect("sends no late snapshot when the scan matches the snapshot", () =>
  Effect.gen(function* () {
    const events = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: ["vscode"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["vscode"]),
        resolveFileManagerRevealKind: () => Effect.succeed(undefined),
      },
    ).pipe(Stream.runCollect);

    assert.equal(events.length, 0);
  }),
);

it.effect("resends a file manager reveal kind that missed the snapshot", () =>
  Effect.gen(function* () {
    const events = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: ["file-manager"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: () => Effect.succeed("file-explorer"),
      },
    ).pipe(Stream.runCollect);

    const [late] = Array.from(events);
    assert.equal(events.length, 1);
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.shellRevealInFileManagerKind, "file-explorer");
    }
  }),
);

const makeParkedWindowsLauncher = Effect.gen(function* () {
  const parkedProbes = yield* Queue.unbounded<void>();
  const release = yield* Deferred.make<void>();
  const launcher = yield* ExternalLauncher.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          stat: () =>
            Queue.offer(parkedProbes, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ type: "File" } as FileSystem.File.Info),
            ),
        }),
        Path.layer,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected spawn")),
        ),
      ),
    ),
  );
  const onWindows = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { PATH: "C:\\t3-late-editors-test", PATHEXT: ".EXE" },
          }),
        ),
      ),
    );
  return {
    editors: {
      resolveAvailableEditors: () => onWindows(launcher.resolveAvailableEditors()),
      resolveFileManagerRevealKind: () => onWindows(launcher.resolveFileManagerRevealKind()),
    },
    probeParked: Queue.take(parkedProbes),
    releaseProbes: Deferred.succeed(release, undefined),
  };
});

it.effect("recovers editors after a real scan outlasts the config timeout", () =>
  Effect.gen(function* () {
    const { editors, probeParked, releaseProbes } = yield* makeParkedWindowsLauncher;

    const snapshotFiber = yield* resolveAvailableEditorsForConfig(
      editors.resolveAvailableEditors(),
    ).pipe(Effect.forkChild);
    yield* probeParked;
    yield* TestClock.adjust(Duration.seconds(5));
    const snapshotEditors = yield* Fiber.join(snapshotFiber);
    assert.deepEqual(snapshotEditors, []);

    const lateFiber = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: snapshotEditors }),
      Stream.empty,
      editors,
    ).pipe(Stream.runCollect, Effect.forkChild);
    yield* releaseProbes;

    const [late] = Array.from(yield* Fiber.join(lateFiber));
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.availableEditors.includes("vscode"), true);
    }
  }).pipe(Effect.scoped),
);

it.effect("recovers a reveal kind whose real probe outlasts the config timeout", () =>
  Effect.gen(function* () {
    const { editors, probeParked, releaseProbes } = yield* makeParkedWindowsLauncher;

    const lateFiber = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: ["file-manager"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: editors.resolveFileManagerRevealKind,
      },
    ).pipe(Stream.runCollect, Effect.forkChild);
    yield* probeParked;
    yield* TestClock.adjust(Duration.seconds(6));
    yield* releaseProbes;

    const [late] = Array.from(yield* Fiber.join(lateFiber));
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.shellRevealInFileManagerKind, "file-explorer");
    }
  }).pipe(Effect.scoped),
);

const ReplayTestLayer = OrchestrationEventStore.layer.pipe(
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.live.each(["thread", "shell"] as const)(
  "%s resume skips unknown types, synchronizes, and receives the live tail",
  (scope) =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-05T00:00:00.000Z";
      const threadId = ThreadId.make("thread:replay");
      const projectId = ProjectId.make("project:replay");
      const project = {
        id: projectId,
        title: "Replay",
        workspaceRoot: "/tmp/replay",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      } satisfies OrchestrationProjectShell;
      const insert = (version: number, unknown = false) => sql<{ sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`replay:${version}`}, ${scope === "thread" ? "thread" : "project"},
          ${scope === "thread" ? threadId : projectId}, ${version},
          ${unknown ? "future.event" : scope === "thread" ? "provider-session.detached" : "project.meta-updated"},
          ${now}, 'server', ${JSON.stringify(
            scope === "thread"
              ? { providerSessionId: "session:replay", detachedAt: now }
              : { projectId, updatedAt: now },
          )}, '{}', 2
        ) RETURNING sequence
      `;
      const [before] = yield* insert(0);
      yield* insert(1, true);
      const [after] = yield* insert(2);
      const [highWater] = yield* insert(3, true);
      const updates = yield* PubSub.unbounded();
      let liveSequence = 0;
      const consume = <A extends { readonly kind: string; readonly sequence?: number }, E, R>(
        stream: Stream.Stream<A, E, R>,
      ) =>
        stream.pipe(
          Stream.tap((item) =>
            Effect.gen(function* () {
              if (item.kind !== "synchronized") return;
              const [live] = yield* insert(4);
              liveSequence = live!.sequence;
              const events = yield* store
                .readApplicationEvents({
                  afterSequence: highWater!.sequence,
                  throughSequence: liveSequence,
                })
                .pipe(Stream.runCollect);
              yield* store.publishCommitted(events);
            }),
          ),
          Stream.takeUntil((item) => item.sequence === liveSequence),
          Stream.map((item) => ({ kind: item.kind as string, sequence: item.sequence })),
          Stream.runCollect,
        );
      const subscription = Effect.gen(function* () {
        return scope === "thread"
          ? yield* subscribeOrchestrationV2Thread({
              threadId,
              afterSequence: before!.sequence,
              requestCompletionMarker: true,
            }).pipe(Effect.flatMap(consume))
          : yield* subscribeOrchestrationV2Shell({
              afterSequence: before!.sequence,
              requestCompletionMarker: true,
            }).pipe(Effect.flatMap(consume));
      });
      const items = yield* subscription.pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          streamStoredEventsFrom: (
            input: Parameters<
              ThreadManagement.ThreadManagementService["Service"]["streamStoredEventsFrom"]
            >[0],
          ) => {
            assert.equal(input?.afterSequence, highWater!.sequence);
            return store
              .streamApplicationEvents({ afterSequence: input?.afterSequence ?? 0 })
              .pipe(
                Stream.filter((event): event is OrchestrationV2StoredEvent => "event" in event),
              );
          },
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(ProjectService.ProjectService, {
          getShell: () => Effect.succeedSome(project),
        } as unknown as ProjectService.ProjectService["Service"]),
        Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
          subscribeChanges: PubSub.subscribe(updates),
        } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
      );
      assert.deepEqual(
        items.map((item) => item.kind),
        scope === "thread"
          ? ["event", "synchronized", "event"]
          : ["project.updated", "synchronized", "project.updated"],
      );
      assert.deepEqual(
        items.flatMap((item) => (item.sequence === undefined ? [] : [item.sequence])),
        [after!.sequence, liveSequence],
      );
    }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.live.each([false, true])(
  "delivers transient previews only to opted-in thread subscriptions (%s)",
  (acceptAssistantPreviews) =>
    Effect.gen(function* () {
      const previews = yield* AssistantPreviewBus.AssistantPreviewBus;
      const threadId = ThreadId.make("thread:preview-rpc");
      const now = DateTime.makeUnsafe("2026-10-15T00:00:00Z");
      const item: OrchestrationV2AssistantMessageItem = {
        id: TurnItemId.make("preview-item"),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "assistant_message",
        messageId: MessageId.make("preview-message"),
        text: "First words",
        streaming: true,
      };
      const live = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
      const eventsAttached = yield* Deferred.make<void>();
      const previewsAttached = yield* Deferred.make<void>();
      const previewObserved = yield* Deferred.make<void>();
      const stream = yield* subscribeOrchestrationV2Thread({
        threadId,
        afterSequence: 0,
        requestCompletionMarker: true,
        acceptAssistantPreviews,
      }).pipe(
        Effect.provideService(AssistantPreviewBus.AssistantPreviewBus, {
          ...previews,
          subscribe: (id) =>
            previews
              .subscribe(id)
              .pipe(Effect.tap(() => Deferred.succeed(previewsAttached, undefined))),
        }),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          streamStoredEventsFrom: () =>
            Stream.unwrap(
              Effect.gen(function* () {
                const subscription = yield* PubSub.subscribe(live);
                yield* Deferred.succeed(eventsAttached, undefined);
                return Stream.fromSubscription(subscription);
              }),
            ),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      );
      const fiber = yield* stream.pipe(
        Stream.tap((item) =>
          item.kind === "assistant-preview"
            ? Deferred.succeed(previewObserved, undefined)
            : Effect.void,
        ),
        Stream.takeUntil((item) => item.kind === "event"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(eventsAttached);
      if (acceptAssistantPreviews) yield* Deferred.await(previewsAttached);
      yield* previews.publish({ ...item, threadId: ThreadId.make("unrelated-thread") });
      yield* previews.publish(item);
      if (acceptAssistantPreviews) yield* Deferred.await(previewObserved);
      yield* PubSub.publish(live, {
        commandId: null,
        sequence: 1,
        event: {
          id: EventId.make("preview-durable-marker"),
          type: "provider-session.detached",
          threadId,
          occurredAt: now,
          payload: {
            providerSessionId: ProviderSessionId.make("preview-session"),
            detachedAt: now,
          },
        },
      });
      const items = Array.from(yield* Fiber.join(fiber));
      assert.deepEqual(
        items.map((item) => item.kind),
        acceptAssistantPreviews
          ? ["synchronized", "assistant-preview", "event"]
          : ["synchronized", "event"],
      );
      const preview = items.find((item) => item.kind === "assistant-preview");
      if (preview?.kind === "assistant-preview") {
        assert.deepEqual(preview.item, item);
        assert.isFalse("sequence" in preview);
      }
      assert.equal(
        yield* (yield* OrchestrationEventStore.OrchestrationEventStore).latestAgentSequence(
          threadId,
        ),
        0,
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(AssistantPreviewBus.layer, ReplayTestLayer))),
);

it.live("buffers an opted-in preview published while the initial snapshot loads", () =>
  Effect.gen(function* () {
    const previews = yield* AssistantPreviewBus.AssistantPreviewBus;
    const threadId = ThreadId.make("snapshot-preview-thread");
    const now = DateTime.makeUnsafe("2026-10-15T00:00:00Z");
    const item: OrchestrationV2AssistantMessageItem = {
      id: TurnItemId.make("snapshot-preview-item"),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "assistant_message",
      messageId: MessageId.make("snapshot-preview-message"),
      text: "Published during snapshot",
      streaming: true,
    };
    const projection = ProjectionStore.emptyProjection({
      id: EventId.make("snapshot-preview-created"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        id: threadId,
        projectId: ProjectId.make("snapshot-preview-project"),
        title: "Snapshot preview",
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    const items = yield* subscribeOrchestrationV2Thread({
      threadId,
      acceptAssistantPreviews: true,
    }).pipe(
      Effect.flatMap((stream) => stream.pipe(Stream.take(2), Stream.runCollect)),
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        ensureLegacyTranscript: () => Effect.void,
        getThreadSnapshot: () =>
          previews.publish(item).pipe(Effect.as({ snapshotSequence: 0, projection })),
        streamStoredEventsFrom: () => Stream.never,
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Effect.timeout("1 second"),
    );
    assert.deepEqual(
      items.map((item) => item.kind),
      ["snapshot", "assistant-preview"],
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(AssistantPreviewBus.layer, ReplayTestLayer))),
);

// Compaction keeps the oldest and newest event per message, so a cursor older
// than the deleted rows still replays each message where the client would
// first have seen it (reducers append on first sight) and reaches the same
// final state. No snapshot fallback is needed.
it.effect("thread resume across compacted history keeps message order and final state", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = "2026-10-13T00:00:00.000Z";
    const threadId = ThreadId.make("thread:compacted");
    const insertMessage = (version: number, id: string, text: string) => sql<{
      sequence: number;
    }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`compacted:${version}`}, 'thread', ${threadId}, ${version}, 'message.updated',
        ${now}, 'server', ${JSON.stringify({
          createdBy: "user",
          creationSource: "web",
          id,
          threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        })}, '{}', 2
      ) RETURNING sequence
    `;
    const [first] = yield* insertMessage(0, "message:a", "a created");
    const [second] = yield* insertMessage(1, "message:b", "b created");
    yield* insertMessage(2, "message:a", "a superseded");
    const [head] = yield* insertMessage(3, "message:a", "a final");
    // thread.deleted is never superseded: clients switch on the event type.
    for (const version of [0, 1]) {
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`deleted:${version}`}, 'thread', 'thread:deleted-twice', ${version}, 'thread.deleted',
          ${now}, 'server', '{}', '{}', 2
        )
      `;
    }
    // Only the event between a's first and newest is deleted.
    assert.equal((yield* maintenance.compactEventStore).deletedEventCount, 1);

    const items = yield* subscribeOrchestrationV2Thread({
      threadId,
      afterSequence: first!.sequence - 1,
      requestCompletionMarker: true,
    }).pipe(
      Effect.flatMap((stream) =>
        stream.pipe(
          Stream.takeUntil((item) => item.kind === "synchronized"),
          Stream.runCollect,
        ),
      ),
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        ensureLegacyTranscript: () => Effect.void,
        streamStoredEventsFrom: () => Stream.never,
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
    );
    assert.deepEqual(
      Array.from(items, (item) =>
        item.kind === "event"
          ? [item.sequence, item.event.type === "message.updated" ? item.event.payload.text : null]
          : [item.kind],
      ),
      [
        [first!.sequence, "a created"],
        [second!.sequence, "b created"],
        [head!.sequence, "a final"],
        ["synchronized"],
      ],
    );
  }).pipe(
    Effect.provide(
      ProjectionMaintenance.layer.pipe(
        Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
        Layer.provideMerge(ReplayTestLayer),
      ),
    ),
  ),
);
