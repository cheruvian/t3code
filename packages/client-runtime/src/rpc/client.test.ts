import * as Exit from "effect/Exit";
import {
  EnvironmentId,
  type RelayClientInstallProgressEvent,
  type ServerLifecycleStreamEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import { RpcClientError } from "effect/rpc";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { request, runStream, subscribe, subscribeDynamicWithSession } from "./client.ts";

const decodeString = Schema.decodeUnknownEffect(Schema.String);

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const INSTALL_CHECKING: RelayClientInstallProgressEvent = {
  type: "progress",
  stage: "checking",
};
const INSTALL_DOWNLOADING: RelayClientInstallProgressEvent = {
  type: "progress",
  stage: "downloading",
};

function session(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input = {}) => client.subscribeServerConfig(input ?? {}),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
}

const makeHarness = Effect.fn("TestEnvironmentRpc.makeHarness")(function* () {
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE);
  const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.none(),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
  const retryCount = yield* Ref.make(0);
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state,
    session: activeSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Ref.update(retryCount, (count) => count + 1),
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  return {
    activeSession,
    retryCount,
    supervisor,
  };
});

describe("environment RPC", () => {
  it.effect.each([true, false])(
    "correlates preview opens with tracing enabled=%s",
    (tracingEnabled) =>
      Effect.gen(function* () {
        const spans: Tracer.Span[] = [];
        let headers: Record<string, string> | undefined;
        const event = {
          type: "opened",
          threadId: "thread",
          tabId: "tab",
          serverEpoch: "epoch",
          revision: 1,
        };
        const client = {
          [WS_METHODS.subscribePreviewEvents]: (
            _input: unknown,
            options: { headers: Record<string, string> },
          ) => {
            headers = options.headers;
            return Stream.fromIterable([event, { ...event, type: "status" }]);
          },
        } as unknown as WsRpcProtocolClient;
        const { activeSession, supervisor } = yield* makeHarness();
        yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
        yield* subscribe(WS_METHODS.subscribePreviewEvents, {}).pipe(
          Stream.take(2),
          Stream.runDrain,
          Effect.provideService(References.TracerEnabled, tracingEnabled),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(
            Tracer.Tracer,
            Tracer.make({
              span(options) {
                const span = new Tracer.NativeSpan(options);
                spans.push(span);
                return span;
              },
            }),
          ),
        );
        const id = headers?.["x-t3-preview-subscription"];
        if (!tracingEnabled) {
          expect(spans).toHaveLength(0);
          return;
        }
        expect(id).toMatch(/^[0-9a-f]{16}$/);
        const markers = spans.filter((span) =>
          [
            "browser.attachment.subscription-start",
            "browser.attachment.open-decoded",
            "browser.attachment.subscription-stop",
          ].includes(span.name),
        );
        expect(markers.map((span) => span.name)).toEqual([
          "browser.attachment.subscription-start",
          "browser.attachment.open-decoded",
          "browser.attachment.subscription-stop",
        ]);
        for (const span of markers) expect(span.attributes.get("subscriptionId")).toBe(id);
        expect(Object.fromEntries(markers[1]!.attributes)).toEqual({
          environmentId: TARGET.environmentId,
          subscriptionId: id,
          threadId: "thread",
          tabId: "tab",
          serverEpoch: "epoch",
          revision: 1,
        });
      }),
  );

  it.effect("binds finite streaming commands to one active session", () =>
    Effect.gen(function* () {
      const firstEvents = yield* Queue.unbounded<RelayClientInstallProgressEvent>();
      const secondEvents = yield* Queue.unbounded<RelayClientInstallProgressEvent>();
      const firstClient = {
        [WS_METHODS.cloudInstallRelayClient]: () => Stream.fromQueue(firstEvents),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.cloudInstallRelayClient]: () => Stream.fromQueue(secondEvents),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      const resultFiber = yield* runStream(WS_METHODS.cloudInstallRelayClient, {}).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      yield* Queue.offer(firstEvents, INSTALL_CHECKING);
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      yield* Queue.offer(secondEvents, INSTALL_DOWNLOADING);
      yield* Queue.offer(firstEvents, INSTALL_DOWNLOADING);

      expect(yield* Fiber.join(resultFiber)).toEqual([INSTALL_CHECKING, INSTALL_DOWNLOADING]);
    }),
  );

  it.effect("switches durable subscriptions when the supervisor replaces the session", () =>
    Effect.gen(function* () {
      const subscriptions: string[] = [];
      const subscriptionChanges = yield* Queue.make<void>();
      const firstClient = {
        [WS_METHODS.subscribeTerminalMetadata]: () => {
          subscriptions.push("first");
          Queue.offerUnsafe(subscriptionChanges, undefined);
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalMetadata]: () => {
          subscriptions.push("second");
          Queue.offerUnsafe(subscriptionChanges, undefined);
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();
      const awaitSubscriptions = Effect.fn("TestEnvironmentRpc.awaitSubscriptions")(function* (
        count: number,
      ) {
        for (;;) {
          if (subscriptions.length >= count) {
            return;
          }
          yield* Queue.take(subscriptionChanges);
        }
      });

      const subscriptionFiber = yield* subscribe(WS_METHODS.subscribeTerminalMetadata, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      yield* awaitSubscriptions(1);
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      yield* awaitSubscriptions(2);
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("keeps the producer session on an old value buffered across a session switch", () =>
    Effect.gen(function* () {
      const firstSubscribed = yield* Deferred.make<void>();
      const secondSubscribed = yield* Deferred.make<void>();
      const firstValueBlocked = yield* Deferred.make<void>();
      const releaseFirstValue = yield* Deferred.make<void>();
      const firstValue = { source: "first", index: 1 } as unknown as ServerLifecycleStreamEvent;
      const bufferedFirstValue = {
        source: "first",
        index: 2,
      } as unknown as ServerLifecycleStreamEvent;
      const secondValue = { source: "second", index: 1 } as unknown as ServerLifecycleStreamEvent;
      const firstClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(firstSubscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.fromIterable([firstValue, bufferedFirstValue])),
            Stream.concat(Stream.never),
          ),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(secondSubscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.make(secondValue)),
            Stream.concat(Stream.never),
          ),
      } as unknown as WsRpcProtocolClient;
      const firstSession = session(firstClient);
      const secondSession = session(secondClient);
      const { activeSession, supervisor } = yield* makeHarness();

      const resultFiber = yield* subscribeDynamicWithSession(
        WS_METHODS.subscribeServerLifecycle,
        () => Effect.succeed({}),
      ).pipe(
        Stream.mapEffect(([producerSession, value]) =>
          value === firstValue
            ? Deferred.succeed(firstValueBlocked, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirstValue)),
                Effect.as([producerSession, value] as const),
              )
            : Effect.succeed([producerSession, value] as const),
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      yield* SubscriptionRef.set(activeSession, Option.some(firstSession));
      yield* Deferred.await(firstSubscribed);
      yield* Deferred.await(firstValueBlocked);
      yield* SubscriptionRef.set(activeSession, Option.some(secondSession));
      yield* Deferred.await(secondSubscribed);
      yield* Deferred.succeed(releaseFirstValue, undefined);

      const result = yield* Fiber.join(resultFiber);
      expect(result).toEqual([
        [firstSession, firstValue],
        [firstSession, bufferedFirstValue],
        [secondSession, secondValue],
      ]);
    }),
  );

  it.effect("keeps durable subscriptions alive across a transport failure and new session", () =>
    Effect.gen(function* () {
      const subscriptions: string[] = [];
      const subscriptionChanges = yield* Queue.make<void>();
      const firstClient = {
        [WS_METHODS.subscribeTerminalMetadata]: () => {
          subscriptions.push("first");
          Queue.offerUnsafe(subscriptionChanges, undefined);
          return Stream.fail(
            new RpcClientError.RpcClientError({
              reason: new Socket.SocketReadError({ cause: new Error("socket closed") }),
            }),
          );
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalMetadata]: () => {
          subscriptions.push("second");
          Queue.offerUnsafe(subscriptionChanges, undefined);
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      const subscriptionFiber = yield* subscribe(WS_METHODS.subscribeTerminalMetadata, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      while (subscriptions.length < 1) {
        yield* Queue.take(subscriptionChanges);
      }
      yield* SubscriptionRef.set(activeSession, Option.none());
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));

      while (subscriptions.length < 2) {
        yield* Queue.take(subscriptionChanges);
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect.each(["protocol", "schema"] as const)(
    "resumes preview discovery after a %s defect on a healthy session",
    (kind) =>
      Effect.gen(function* () {
        const failed = yield* Deferred.make<void>();
        const firstReceived = yield* Deferred.make<void>();
        const breakStream = yield* Deferred.make<void>();
        const observed: string[] = [];
        let attempts = 0;
        const opened = (tabId: string) => ({
          type: "opened" as const,
          threadId: "background-thread",
          tabId,
          serverEpoch: "epoch-1",
          revision: tabId === "first" ? 1 : 2,
          createdAt: "2026-11-05T00:00:00.000Z",
          snapshot: {
            threadId: "background-thread",
            tabId,
            navStatus: { _tag: "Idle" as const },
            canGoBack: false,
            canGoForward: false,
            updatedAt: "2026-11-05T00:00:00.000Z",
          },
        });
        const failure =
          kind === "protocol"
            ? Stream.fail(
                new RpcClientError.RpcClientError({
                  reason: new RpcClientError.RpcClientDefect({
                    message: "Malformed response",
                    cause: null,
                  }),
                }),
              )
            : Stream.fromEffect(decodeString(null).pipe(Effect.orDie));
        const client = {
          [WS_METHODS.previewList]: () =>
            Effect.succeed({
              serverEpoch: "epoch-1",
              revision: 2,
              sessions: [opened("second").snapshot],
            }),
          [WS_METHODS.subscribePreviewEvents]: () => {
            attempts += 1;
            return attempts === 1
              ? Stream.make(opened("first")).pipe(
                  Stream.concat(Stream.fromEffect(Deferred.await(breakStream)).pipe(Stream.drain)),
                  Stream.concat(failure),
                )
              : Stream.make(opened("second")).pipe(Stream.concat(Stream.never));
          },
        } as unknown as WsRpcProtocolClient;
        const { activeSession, supervisor, retryCount } = yield* makeHarness();
        const current = session(client);
        yield* SubscriptionRef.set(activeSession, Option.some(current));
        const fiber = yield* subscribe(
          WS_METHODS.subscribePreviewEvents,
          {},
          {
            onDefect: () => Deferred.succeed(failed, undefined).pipe(Effect.asVoid),
          },
        ).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              observed.push(event.tabId);
              Deferred.doneUnsafe(firstReceived, Exit.void);
            }),
          ),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );
        yield* Deferred.await(firstReceived);
        yield* Deferred.succeed(breakStream, undefined);
        yield* Deferred.await(failed);
        const list = yield* request(WS_METHODS.previewList, {}).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        );
        expect(list.sessions.map((tab) => tab.tabId)).toEqual(["second"]);
        yield* TestClock.adjust("250 millis");
        expect(observed).toEqual(["first", "second"]);
        expect(yield* SubscriptionRef.get(activeSession)).toEqual(Option.some(current));
        expect(yield* Ref.get(retryCount)).toBe(0);
        yield* Fiber.interrupt(fiber);
      }),
  );

  it.effect(
    "backs off repeated decoding failures and cancels the retry when the session changes",
    () =>
      Effect.gen(function* () {
        let attempts = 0;
        const failed = yield* Deferred.make<void>();
        const client = {
          [WS_METHODS.subscribePreviewEvents]: () => {
            attempts += 1;
            return Stream.fromEffect(decodeString(null).pipe(Effect.orDie));
          },
        } as unknown as WsRpcProtocolClient;
        const { activeSession, supervisor } = yield* makeHarness();
        yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
        const fiber = yield* subscribe(
          WS_METHODS.subscribePreviewEvents,
          {},
          {
            onDefect: () => Deferred.succeed(failed, undefined).pipe(Effect.asVoid),
          },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );
        yield* Deferred.await(failed);
        expect(attempts).toBe(1);
        yield* TestClock.adjust("250 millis");
        expect(attempts).toBe(2);
        yield* TestClock.adjust("250 millis");
        expect(attempts).toBe(2);
        yield* TestClock.adjust("250 millis");
        expect(attempts).toBe(3);
        const replaced = yield* Deferred.make<void>();
        yield* SubscriptionRef.set(
          activeSession,
          Option.some(
            session({
              [WS_METHODS.subscribePreviewEvents]: () =>
                Stream.fromEffect(Deferred.succeed(replaced, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.never),
                ),
            } as unknown as WsRpcProtocolClient),
          ),
        );
        yield* Deferred.await(replaced);
        yield* TestClock.adjust("30 seconds");
        expect(attempts).toBe(3);
        yield* Fiber.interrupt(fiber);
      }),
  );

  it.effect("surfaces domain subscription failures without reconnecting", () =>
    Effect.gen(function* () {
      const domainError = new Error("terminal subscription rejected");
      const client = {
        [WS_METHODS.subscribeTerminalMetadata]: () => Stream.fail(domainError),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const error = yield* subscribe(WS_METHODS.subscribeTerminalMetadata, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );

      expect(error).toBe(domainError);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("keeps handled domain failures dormant until a replacement session arrives", () =>
    Effect.gen(function* () {
      const domainError = new Error("terminal subscription rejected");
      const subscriptions: string[] = [];
      const subscriptionChanges = yield* Queue.make<void>();
      const observedFailures: Error[] = [];
      const failureObserved = yield* Deferred.make<void>();
      const firstClient = {
        [WS_METHODS.subscribeTerminalMetadata]: () => {
          subscriptions.push("first");
          Queue.offerUnsafe(subscriptionChanges, undefined);
          return Stream.fail(domainError);
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalMetadata]: () => {
          subscriptions.push("second");
          Queue.offerUnsafe(subscriptionChanges, undefined);
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      const subscriptionFiber = yield* subscribe(
        WS_METHODS.subscribeTerminalMetadata,
        {},
        {
          onExpectedFailure: (cause) =>
            Effect.sync(() => {
              observedFailures.push(Cause.squash(cause) as Error);
              Deferred.doneUnsafe(failureObserved, Effect.void);
            }),
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Deferred.await(failureObserved);

      expect(subscriptions).toEqual(["first"]);
      expect(observedFailures).toEqual([domainError]);

      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      while (subscriptions.length < 2) {
        yield* Queue.take(subscriptionChanges);
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect.each(["input", "stream"] as const)(
    "reports %s subscription defects and resubscribes on the next session",
    (where) =>
      Effect.gen(function* () {
        const defect = new Error("subscription invariant failed");
        let expectedFailureCount = 0;
        let inputs = 0;
        let streams = 0;
        const observedDefects: unknown[] = [];
        const defectObserved = yield* Deferred.make<void>();
        const resubscribed = yield* Deferred.make<void>();
        const firstClient = {
          [WS_METHODS.subscribeTerminalMetadata]: () => {
            streams += 1;
            return where === "stream" ? Stream.die(defect) : Stream.never;
          },
        } as unknown as WsRpcProtocolClient;
        const secondClient = {
          [WS_METHODS.subscribeTerminalMetadata]: () => {
            Deferred.doneUnsafe(resubscribed, Effect.void);
            return Stream.never;
          },
        } as unknown as WsRpcProtocolClient;
        const { activeSession, supervisor } = yield* makeHarness();

        yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
        const subscriptionFiber = yield* subscribeDynamicWithSession(
          WS_METHODS.subscribeTerminalMetadata,
          () =>
            Effect.suspend(() => {
              inputs += 1;
              return where === "input" && inputs === 1 ? Effect.die(defect) : Effect.succeed({});
            }),
          {
            onDefect: (cause) =>
              Effect.sync(() => {
                observedDefects.push(Cause.squash(cause));
                Deferred.doneUnsafe(defectObserved, Effect.void);
              }),
            onExpectedFailure: () =>
              Effect.sync(() => {
                expectedFailureCount += 1;
              }),
            retryExpectedFailureAfter: "250 millis",
          },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );
        yield* Deferred.await(defectObserved);

        expect(inputs).toBe(1);
        expect(streams).toBe(where === "input" ? 0 : 1);
        expect(expectedFailureCount).toBe(0);
        expect(observedDefects).toEqual([defect]);

        // Let the defect settle before the next session arrives, as it does on a real device.
        yield* TestClock.adjust("1 second");
        expect(subscriptionFiber.pollUnsafe()).toBeUndefined();
        yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
        yield* Deferred.await(resubscribed);
        yield* Fiber.interrupt(subscriptionFiber);

        expect(inputs).toBe(2);
      }),
  );
});
