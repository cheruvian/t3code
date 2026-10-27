import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  NotificationSendInput,
  NotificationMode,
  type NotificationSendResult,
  WebPushError,
  WebPushSubscription,
  type WebPushUpdate,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { turnItemUpdateCanEndBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import { forkParked } from "../serverActivation.ts";
import * as WebPushTransport from "./WebPushTransport.ts";

const StoredSubscription = Schema.Struct({
  sessionId: AuthSessionId,
  subscription: WebPushSubscription,
  notificationMode: NotificationMode,
  delivered: Schema.Array(Schema.String),
});
const StoredState = Schema.Struct({
  publicKey: Schema.String,
  privateKey: Schema.String,
  subscriptions: Schema.Array(StoredSubscription),
});
type StoredState = typeof StoredState.Type;
const isWebPushError = Schema.is(WebPushError);
const decodeNotification = Schema.decodeUnknownEffect(NotificationSendInput);
const SECRET = "web-push";
const decodeState = Schema.decodeEffect(Schema.fromJsonString(StoredState));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(StoredState));
const NotificationPayload = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  tag: Schema.String,
  url: Schema.String,
  silent: Schema.optionalKey(Schema.Boolean),
});
const encodeNotification = Schema.encodeEffect(Schema.fromJsonString(NotificationPayload));

export class WebPush extends Context.Service<
  WebPush,
  {
    readonly config: (
      sessionId: AuthSessionId,
      endpoint?: string,
    ) => Effect.Effect<
      {
        publicKey: string;
        enabled: boolean;
      },
      WebPushError
    >;
    readonly update: (
      sessionId: AuthSessionId,
      input: WebPushUpdate,
    ) => Effect.Effect<void, WebPushError>;
    readonly send: (
      input: NotificationSendInput,
    ) => Effect.Effect<NotificationSendResult, WebPushError>;
    readonly notify: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/notifications/WebPush") {}

function relevantEvent(event: OrchestrationV2DomainEvent): boolean {
  return (
    (event.type === "run.updated" &&
      (event.payload.status === "completed" || event.payload.status === "failed")) ||
    (event.type === "runtime-request.updated" && event.payload.status === "pending") ||
    (event.type === "turn-item.updated" && turnItemUpdateCanEndBackgroundWork(event.payload))
  );
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const deliveryLock = yield* Semaphore.make(1);
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const sessions = yield* AuthSessions.AuthSessionRepository;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const transport = yield* WebPushTransport.WebPushTransport;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const lock = yield* Semaphore.make(1);
  const startedAt = yield* DateTime.now;
  let state: StoredState | undefined;
  let absent = false;

  const load = Effect.gen(function* () {
    if (state !== undefined) return state;
    const stored = yield* secrets.get(SECRET);
    if (Option.isSome(stored)) {
      state = yield* decodeState(new TextDecoder().decode(stored.value));
    } else {
      const initial = { ...(yield* transport.generateKeys), subscriptions: [] };
      yield* secrets.set(SECRET, new TextEncoder().encode(yield* encodeState(initial)));
      state = initial;
    }
    return state;
  }).pipe(Effect.mapError(() => new WebPushError({ reason: "storage" })));

  const save = (next: StoredState) =>
    encodeState(next).pipe(
      Effect.flatMap((encoded) => secrets.set(SECRET, new TextEncoder().encode(encoded))),
      Effect.mapError(() => new WebPushError({ reason: "storage" })),
      Effect.tap(() =>
        Effect.sync(() => {
          state = next;
        }),
      ),
    );

  const config: WebPush["Service"]["config"] = (sessionId, endpoint) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* load;
        return {
          publicKey: current.publicKey,
          enabled: current.subscriptions.some(
            (entry) => entry.sessionId === sessionId && entry.subscription.endpoint === endpoint,
          ),
        };
      }),
    );

  const update: WebPush["Service"]["update"] = (sessionId, input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (
          input.type === "subscribe" &&
          !WebPushTransport.isSupportedPushEndpoint(input.subscription.endpoint)
        ) {
          return yield* new WebPushError({ reason: "invalid-subscription" });
        }
        const current = yield* load;
        const endpoint = input.type === "subscribe" ? input.subscription.endpoint : input.endpoint;
        const existing = current.subscriptions.find(
          (entry) => entry.subscription.endpoint === endpoint,
        );
        if (input.type === "unsubscribe" && existing?.sessionId !== sessionId) return;
        const subscriptions = current.subscriptions.filter(
          (entry) => entry.subscription.endpoint !== endpoint,
        );
        if (input.type === "subscribe") {
          if (subscriptions.length >= 100) return yield* new WebPushError({ reason: "limit" });
          subscriptions.push({
            sessionId,
            subscription: input.subscription,
            notificationMode: input.notificationMode,
            delivered: existing?.sessionId === sessionId ? existing.delivered : [],
          });
        }
        yield* save({ ...current, subscriptions });
      }),
    );

  const broadcast = (
    payload: typeof NotificationPayload.Type,
    notificationId: string,
    threadNotification = false,
  ) =>
    deliveryLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* lock.withPermits(1)(load);
        const counts = {
          subscribed: current.subscriptions.length,
          sent: 0,
          failed: 0,
          expired: 0,
          skipped: 0,
        };
        for (const entry of current.subscriptions) {
          if (
            threadNotification &&
            (entry.notificationMode === "off" || entry.notificationMode === "sound")
          )
            continue;
          if (entry.delivered.includes(notificationId)) {
            counts.skipped++;
            continue;
          }
          const session = yield* sessions.getById({ sessionId: entry.sessionId });
          const now = yield* DateTime.now;
          const authorized =
            Option.isSome(session) &&
            session.value.revokedAt === null &&
            DateTime.toEpochMillis(session.value.expiresAt) > DateTime.toEpochMillis(now) &&
            session.value.scopes.includes(AuthOrchestrationReadScope);
          const encoded = yield* encodeNotification({
            ...payload,
            ...(threadNotification ? { silent: entry.notificationMode === "notifications" } : {}),
          });
          const result = authorized
            ? yield* transport.send(entry.subscription, encoded, current).pipe(
                Effect.retry({ times: 2 }),
                Effect.orElseSucceed(() => "failed" as const),
              )
            : "expired";
          if (result === "failed") {
            counts.failed++;
            yield* Effect.logWarning("Background push delivery failed");
            continue;
          }
          if (result === "expired") counts.expired++;
          else counts.sent++;
          yield* lock.withPermits(1)(
            Effect.gen(function* () {
              const latest = yield* load;
              yield* save({
                ...latest,
                subscriptions: latest.subscriptions.flatMap((candidate) => {
                  if (candidate !== entry) return [candidate];
                  if (result === "expired") return [];
                  return [
                    {
                      ...candidate,
                      delivered: [...candidate.delivered.slice(-127), notificationId],
                    },
                  ];
                }),
              });
            }),
          );
        }
        return counts;
      }),
    );

  const send: WebPush["Service"]["send"] = (input) =>
    Effect.gen(function* () {
      const message = yield* decodeNotification(input).pipe(
        Effect.mapError(() => new WebPushError({ reason: "invalid-message" })),
      );
      const notificationId = `custom:${message.idempotencyKey ?? (yield* crypto.randomUUIDv4())}`;
      const payload = {
        title: message.title,
        body: message.body,
        url: message.url ?? "/",
        tag: message.tag === undefined ? notificationId : `custom:${message.tag}`,
      };
      if (new TextEncoder().encode(yield* encodeNotification(payload)).byteLength > 3500)
        return yield* new WebPushError({ reason: "invalid-message" });
      return yield* broadcast(payload, notificationId);
    }).pipe(
      Effect.mapError((error) =>
        isWebPushError(error) ? error : new WebPushError({ reason: "storage" }),
      ),
    );

  const notifyUnsafe = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
    if (
      !relevantEvent(event) ||
      DateTime.toEpochMillis(event.occurredAt) < DateTime.toEpochMillis(startedAt)
    )
      return;
    // No keys, projection reads, or disk writes until a device opts in.
    if (state === undefined) {
      if (absent) return;
      const stored = yield* secrets.get(SECRET);
      if (Option.isNone(stored)) {
        absent = true;
        return;
      }
    }
    const current = yield* lock.withPermits(1)(load);
    if (current.subscriptions.length === 0) return;
    const activity = yield* backgroundPolicy.snapshot;
    if (
      activity.leases.some(
        (lease) =>
          (lease.clientKind === "web" || lease.clientKind === "desktop-renderer") &&
          lease.visible &&
          lease.focused &&
          lease.recentlyInteracted,
      )
    )
      return;
    const source = yield* threads.getThreadShell(event.threadId);
    if (source === null || source.archivedAt !== null || source.deletedAt !== null) return;
    let thread: OrchestrationV2ThreadShell = source;
    if (source.lineage.relationshipToParent === "subagent" && source.pendingRuntimeRequest === null)
      return;
    while (thread.lineage.relationshipToParent === "subagent") {
      if (thread.lineage.parentThreadId === null) return;
      const parent: OrchestrationV2ThreadShell | null = yield* threads.getThreadShell(
        thread.lineage.parentThreadId,
      );
      if (parent === null || parent.archivedAt !== null || parent.deletedAt !== null) return;
      thread = parent;
    }
    const environmentId = yield* environment.getEnvironmentId;
    const awareness = projectThreadAwarenessV2({
      environmentId,
      project: { title: "" },
      thread: { ...source, lineage: thread.lineage },
    });
    if (awareness === null) return;
    const request = source.pendingRuntimeRequest;
    const notificationId =
      awareness.phase === "waiting_for_input" || awareness.phase === "waiting_for_approval"
        ? request?.id
        : (awareness.phase === "completed" || awareness.phase === "failed") &&
            source.latestRunCompletedAt != null
          ? `${source.latestRunId}:${awareness.phase}`
          : undefined;
    if (notificationId === undefined) return;
    const notificationAt = request?.createdAt ?? source.latestRunCompletedAt;
    if (
      notificationAt == null ||
      DateTime.toEpochMillis(notificationAt) < DateTime.toEpochMillis(startedAt)
    )
      return;
    const payload = {
      title: awareness.headline,
      body: thread.title.slice(0, 200),
      tag: `${environmentId}:${thread.id}`,
      url: `/${encodeURIComponent(environmentId)}/${encodeURIComponent(thread.id)}`,
    };
    yield* broadcast(payload, notificationId, true);
  });
  const deliver = (event: OrchestrationV2DomainEvent) =>
    notifyUnsafe(event).pipe(
      Effect.catch(() => Effect.logWarning("Background push notification could not be processed")),
    );
  const worker = yield* makeDrainableWorker(deliver);
  const notify = (event: OrchestrationV2DomainEvent) =>
    worker.enqueue(event).pipe(Effect.andThen(worker.drain));
  yield* forkParked(
    Stream.runForEach(threads.streamDomainEvents, (event) =>
      relevantEvent(event) ? worker.enqueue(event) : Effect.void,
    ),
  );
  return WebPush.of({ config, update, send, notify, drain: worker.drain });
});

export const layer = Layer.effect(WebPush, make);
