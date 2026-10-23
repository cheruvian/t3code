import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  WebPushError,
  AuthSessionId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  RuntimeRequestId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type WebPushSubscription,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as WebPush from "./WebPush.ts";
import * as WebPushTransport from "./WebPushTransport.ts";

const THREAD_ID = ThreadId.make("push-thread");
const PROJECT_ID = ProjectId.make("push-project");
const SESSION_ID = AuthSessionId.make("push-session");
const NOW = "2030-01-01T00:00:00.000Z";
const subscription: WebPushSubscription = {
  endpoint: "https://web.push.apple.com/test-device",
  keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) },
};
function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "running",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: DateTime.makeUnsafe(NOW),
    updatedAt: DateTime.makeUnsafe(NOW),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

function completedEvent(): OrchestrationV2DomainEvent {
  const now = DateTime.makeUnsafe(NOW);
  return {
    id: EventId.make("event-1"),
    threadId: THREAD_ID,
    occurredAt: now,
    type: "run.updated",
    payload: {
      id: RunId.make("run-1"),
      threadId: THREAD_ID,
      ordinal: 1,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
      providerThreadId: null,
      userMessageId: MessageId.make("message-1"),
      rootNodeId: null,
      activeAttemptId: null,
      status: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    },
  };
}

function requestEvent(
  id: string,
  kind: "user_input" | "command" = "user_input",
): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event-${id}`),
    threadId: THREAD_ID,
    occurredAt: DateTime.makeUnsafe(NOW),
    type: "runtime-request.updated",
    payload: {
      id: RuntimeRequestId.make(id),
      nodeId: NodeId.make("node-1"),
      providerTurnId: null,
      nativeRequestRef: null,
      kind,
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: DateTime.makeUnsafe(NOW),
      resolvedAt: null,
    },
  };
}

const setup = Effect.gen(function* () {
  const event = yield* Deferred.make<OrchestrationV2DomainEvent>();
  const enqueued = yield* Deferred.make<void>();
  const bytes = new Map<string, Uint8Array>();
  const sent: Array<{ subscription: WebPushSubscription; payload: string }> = [];
  const relatedShells = new Map<ThreadId, OrchestrationV2ThreadShell>();
  let expired = false;
  let failed = false;
  let revoked = false;
  let currentShell = shell({
    status: "completed",
    latestRunId: RunId.make("run-1"),
    latestRunCompletedAt: DateTime.makeUnsafe(NOW),
  });
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: (name) => Effect.sync(() => Option.fromNullishOr(bytes.get(name))),
      set: (name, value) =>
        Effect.sync(() => {
          bytes.set(name, value);
        }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.sync(() =>
          threadId === currentShell.id ? currentShell : (relatedShells.get(threadId) ?? null),
        ),
      streamDomainEvents: Stream.concat(
        Stream.fromEffect(Deferred.await(event)),
        Stream.fromEffect(Deferred.succeed(enqueued, undefined)).pipe(Stream.drain),
      ),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-1")),
    }),
    Layer.mock(AuthSessions.AuthSessionRepository)({
      getById: () =>
        Effect.sync(() =>
          Option.some({
            sessionId: SESSION_ID,
            subject: "test",
            scopes: [AuthOrchestrationReadScope],
            method: "browser-session-cookie" as const,
            client: {
              label: null,
              ipAddress: null,
              userAgent: null,
              deviceType: "unknown" as const,
              os: null,
              browser: null,
            },
            issuedAt: DateTime.makeUnsafe("2025-01-01"),
            expiresAt: DateTime.makeUnsafe("2099-01-01"),
            lastConnectedAt: null,
            revokedAt: revoked ? DateTime.makeUnsafe(NOW) : null,
          }),
        ),
    }),
    Layer.succeed(WebPushTransport.WebPushTransport, {
      generateKeys: Effect.succeed({ publicKey: "test-public", privateKey: "test-private" }),
      send: (sub, payload) =>
        Effect.gen(function* () {
          sent.push({ subscription: sub, payload });
          if (failed) return yield* new WebPushError({ reason: "delivery" });
          return expired ? ("expired" as const) : ("sent" as const);
        }),
    }),
  );
  const context = yield* Layer.build(WebPush.layer.pipe(Layer.provide(dependencies)));
  const service = yield* WebPush.WebPush.pipe(Effect.provide(context));
  return {
    service,
    sent,
    emit: (value: OrchestrationV2DomainEvent) =>
      Deferred.succeed(event, value).pipe(
        Effect.andThen(Deferred.await(enqueued)),
        Effect.andThen(service.drain),
      ),
    restart: Effect.gen(function* () {
      const next = yield* Layer.build(WebPush.layer.pipe(Layer.provide(dependencies)));
      return yield* WebPush.WebPush.pipe(Effect.provide(next));
    }),
    addRelatedShell: (value: OrchestrationV2ThreadShell) => {
      relatedShells.set(value.id, value);
    },
    failDelivery: (value: boolean) => {
      failed = value;
    },
    expire: () => {
      expired = true;
    },
    revoke: () => {
      revoked = true;
    },
    setShell: (next: OrchestrationV2ThreadShell) => {
      currentShell = next;
    },
  };
});

describe("background push", () => {
  it.effect.each(["off", "sound", "notifications", "notifications-and-sound"] as const)(
    "honors %s for thread alerts while keeping custom API notifications independent",
    (notificationMode) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { service, sent } = yield* setup;
          yield* service.update(SESSION_ID, { type: "subscribe", subscription, notificationMode });
          yield* service.notify(completedEvent());
          const hasAlerts =
            notificationMode === "notifications" || notificationMode === "notifications-and-sound";
          expect(sent).toHaveLength(hasAlerts ? 1 : 0);
          if (hasAlerts)
            expect(sent[0]?.payload).toContain(`"silent":${notificationMode === "notifications"}`);
          const custom = yield* service.send({ title: "Backup", body: "Finished" });
          expect(custom.sent).toBe(1);
          expect(sent).toHaveLength(hasAlerts ? 2 : 1);
        }),
      ),
  );

  it.effect(
    "updates persisted thread preferences when the device changes notification controls",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { service, sent, restart } = yield* setup;
          yield* service.update(SESSION_ID, {
            type: "subscribe",
            subscription,
            notificationMode: "notifications",
          });
          yield* service.update(SESSION_ID, {
            type: "subscribe",
            subscription,
            notificationMode: "off",
          });
          const restarted = yield* restart;
          yield* restarted.notify(completedEvent());
          expect(sent).toHaveLength(0);
          expect((yield* restarted.send({ title: "Job", body: "Done" })).sent).toBe(1);
        }),
      ),
  );

  it.effect("broadcasts custom notifications and safely deduplicates concurrent retries", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { service, sent } = yield* setup;
        expect(yield* service.send({ title: "Backup", body: "Done" })).toEqual({
          subscribed: 0,
          sent: 0,
          failed: 0,
          expired: 0,
          skipped: 0,
        });
        yield* service.update(SESSION_ID, {
          type: "subscribe",
          notificationMode: "notifications-and-sound",
          subscription,
        });
        yield* service.update(SESSION_ID, {
          type: "subscribe",
          notificationMode: "notifications-and-sound",
          subscription: { ...subscription, endpoint: "https://web.push.apple.com/second-device" },
        });
        const input = {
          title: "Backup complete",
          body: "Database archived",
          url: "https://example.com/jobs/42",
          tag: "backup",
          idempotencyKey: "backup-42",
        };
        const results = yield* Effect.all([service.send(input), service.send(input)], {
          concurrency: 2,
        });
        expect(results.map((result) => result.sent).sort()).toEqual([0, 2]);
        expect(results.map((result) => result.skipped).sort()).toEqual([0, 2]);
        expect(sent).toHaveLength(2);
        expect(sent[0]?.payload).toContain("https://example.com/jobs/42");
        expect(sent[0]?.payload).toContain("custom:backup");
        expect((yield* service.send({ ...input, idempotencyKey: "backup-43" })).sent).toBe(2);
      }),
    ),
  );

  it.effect(
    "reports failed deliveries without marking them delivered, so the caller can retry",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { service, failDelivery } = yield* setup;
          yield* service.update(SESSION_ID, {
            type: "subscribe",
            notificationMode: "notifications-and-sound",
            subscription,
          });
          const input = { title: "Build", body: "Done", idempotencyKey: "build-1" };
          failDelivery(true);
          expect((yield* service.send(input)).failed).toBe(1);
          failDelivery(false);
          expect((yield* service.send(input)).sent).toBe(1);
          expect((yield* service.send(input)).skipped).toBe(1);
        }),
      ),
  );

  it.effect("rejects invalid custom content and oversized encrypted-push payloads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { service, sent } = yield* setup;
        const blank = yield* service.send({ title: " ", body: "message" }).pipe(Effect.flip);
        expect(blank.reason).toBe("invalid-message");
        const unsafe = yield* service
          .send({ title: "Title", body: "message", url: "javascript:alert(1)" })
          .pipe(Effect.flip);
        expect(unsafe.reason).toBe("invalid-message");
        const large = yield* service
          .send({ title: "Title", body: "😀".repeat(1000) })
          .pipe(Effect.flip);
        expect(large.reason).toBe("invalid-message");
        expect(sent).toHaveLength(0);
      }),
    ),
  );

  it.effect("routes a subagent's approval to its parent without notifying child completions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { service, sent, setShell, addRelatedShell } = yield* setup;
        yield* service.update(SESSION_ID, {
          type: "subscribe",
          notificationMode: "notifications-and-sound",
          subscription,
        });
        const root = ThreadId.make("root-thread");
        addRelatedShell(
          shell({
            id: root,
            title: "Parent work",
            lineage: { rootThreadId: root, parentThreadId: null, relationshipToParent: null },
          }),
        );
        const child = shell({
          status: "completed",
          latestRunId: RunId.make("run-1"),
          latestRunCompletedAt: DateTime.makeUnsafe(NOW),
          lineage: { rootThreadId: root, parentThreadId: root, relationshipToParent: "subagent" },
        });
        setShell(child);
        yield* service.notify(completedEvent());
        expect(sent).toHaveLength(0);
        setShell({
          ...child,
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("approval-1"),
            kind: "command",
            createdAt: DateTime.makeUnsafe(NOW),
          },
        });
        yield* service.notify(requestEvent("approval-1", "command"));
        expect(sent[0]?.payload).toContain("/environment-1/root-thread");
        expect(sent[0]?.payload).toContain("Parent work");
      }),
    ),
  );

  it.effect("delivers failures and approval requests", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { service, sent, setShell } = yield* setup;
        yield* service.update(SESSION_ID, {
          type: "subscribe",
          notificationMode: "notifications-and-sound",
          subscription,
        });
        setShell(
          shell({
            status: "failed",
            latestRunId: RunId.make("failed-run"),
            latestRunCompletedAt: DateTime.makeUnsafe(NOW),
          }),
        );
        const event = completedEvent();
        if (event.type !== "run.updated") throw new Error("Expected a run event");
        yield* service.notify({ ...event, payload: { ...event.payload, status: "failed" } });
        expect(sent[0]?.payload).toContain("Agent failed");
        setShell(
          shell({
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("approval-1"),
              kind: "command",
              createdAt: DateTime.makeUnsafe(NOW),
            },
          }),
        );
        yield* service.notify(requestEvent("approval-1", "command"));
        expect(sent[1]?.payload).toContain("Approval needed");
      }),
    ),
  );

  it.effect("receives committed domain events through the background worker", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { service, sent, emit } = yield* setup;
        yield* service.update(SESSION_ID, {
          type: "subscribe",
          notificationMode: "notifications-and-sound",
          subscription,
        });
        yield* emit(completedEvent());
        expect(sent).toHaveLength(1);
      }),
    ),
  );

  it.effect(
    "delivers once per run, preserves keys and delivery history across restart, and disables",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { service, sent, restart } = yield* setup;
          const before = yield* service.config(SESSION_ID);
          yield* service.update(SESSION_ID, {
            type: "subscribe",
            notificationMode: "notifications-and-sound",
            subscription,
          });
          yield* service.notify(completedEvent());
          yield* service.notify(completedEvent());
          expect(sent).toHaveLength(1);
          expect(sent[0]?.payload).toContain("/environment-1/push-thread");
          const restarted = yield* restart;
          expect((yield* restarted.config(SESSION_ID, subscription.endpoint)).publicKey).toBe(
            before.publicKey,
          );
          yield* restarted.notify(completedEvent());
          expect(sent).toHaveLength(1);
          yield* restarted.update(SESSION_ID, {
            type: "unsubscribe",
            endpoint: subscription.endpoint,
          });
          expect((yield* restarted.config(SESSION_ID, subscription.endpoint)).enabled).toBe(false);
          yield* restarted.notify(completedEvent());
          expect(sent).toHaveLength(1);
        }),
      ),
  );

  it.effect("removes expired subscriptions and stops delivery after session revocation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { service, sent, expire, revoke } = yield* setup;
        yield* service.update(SESSION_ID, {
          type: "subscribe",
          notificationMode: "notifications-and-sound",
          subscription,
        });
        expire();
        yield* service.notify(completedEvent());
        expect(sent).toHaveLength(1);
        expect((yield* service.config(SESSION_ID, subscription.endpoint)).enabled).toBe(false);
        yield* service.update(SESSION_ID, {
          type: "subscribe",
          notificationMode: "notifications-and-sound",
          subscription,
        });
        revoke();
        yield* service.notify(completedEvent());
        expect(sent).toHaveLength(1);
        expect((yield* service.config(SESSION_ID, subscription.endpoint)).enabled).toBe(false);
      }),
    ),
  );

  it.effect(
    "notifies for distinct input requests but ignores archived threads and unfinished background work",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { service, sent, setShell } = yield* setup;
          yield* service.update(SESSION_ID, {
            type: "subscribe",
            notificationMode: "notifications-and-sound",
            subscription,
          });
          setShell(shell({ archivedAt: DateTime.makeUnsafe(NOW) }));
          yield* service.notify(completedEvent());
          expect(sent).toHaveLength(0);
          const request = {
            id: RuntimeRequestId.make("request-1"),
            kind: "user_input" as const,
            createdAt: DateTime.makeUnsafe(NOW),
          };
          setShell(shell({ pendingRuntimeRequest: request }));
          yield* service.notify(requestEvent("request-1"));
          expect(sent).toHaveLength(1);
          expect(sent[0]?.payload).toContain("Waiting for input");
          setShell(
            shell({
              pendingRuntimeRequest: { ...request, id: RuntimeRequestId.make("request-2") },
            }),
          );
          yield* service.notify(requestEvent("request-2"));
          expect(sent).toHaveLength(2);
          setShell(
            shell({
              status: "completed",
              latestRunId: RunId.make("run-1"),
              latestRunCompletedAt: DateTime.makeUnsafe(NOW),
              pendingBackgroundTasks: [{ taskId: "task-1", kind: "background_task" }],
            }),
          );
          yield* service.notify(completedEvent());
          expect(sent).toHaveLength(2);
        }),
      ),
  );

  it.effect(
    "rejects arbitrary endpoint hosts and prevents another session from disabling a device",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { service } = yield* setup;
          const error = yield* service
            .update(SESSION_ID, {
              type: "subscribe",
              notificationMode: "notifications-and-sound",
              subscription: { ...subscription, endpoint: "https://127.0.0.1/private" },
            })
            .pipe(Effect.flip);
          expect(error.reason).toBe("invalid-subscription");
          yield* service.update(SESSION_ID, {
            type: "subscribe",
            notificationMode: "notifications-and-sound",
            subscription,
          });
          yield* service.update(AuthSessionId.make("another-session"), {
            type: "unsubscribe",
            endpoint: subscription.endpoint,
          });
          expect((yield* service.config(SESSION_ID, subscription.endpoint)).enabled).toBe(true);
        }),
      ),
  );
});
