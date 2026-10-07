import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ConnectionBlockedError, type ConnectionAttemptError } from "./model.ts";

const seconds = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 300 })));
export const ConnectionTimingSettings = Schema.Struct({
  setupSeconds: seconds,
  requestSeconds: seconds,
  resumeProbeSeconds: seconds,
  heartbeatSeconds: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 300 }))),
  retryMaxSeconds: seconds,
});
export type ConnectionTimingSettings = typeof ConnectionTimingSettings.Type;
const decodeTiming = Schema.decodeEffect(ConnectionTimingSettings);

export const DEFAULT_CONNECTION_TIMING: ConnectionTimingSettings = {
  setupSeconds: 15,
  requestSeconds: 10,
  resumeProbeSeconds: 3,
  heartbeatSeconds: 0,
  retryMaxSeconds: 300,
};

export const CONNECTION_TIMING_FIELDS = [
  {
    key: "setupSeconds",
    label: "Connection setup",
    description:
      "Time allowed for authentication, opening the connection, and initial server configuration.",
    options: [15, 30, 60, 120, 300],
  },
  {
    key: "requestSeconds",
    label: "Authentication requests",
    description:
      "Time allowed for each remote authentication or server discovery request. Connection setup must allow enough time for these requests together.",
    options: [10, 15, 30, 60, 120],
  },
  {
    key: "resumeProbeSeconds",
    label: "Foreground health check",
    description:
      "Time to wait for an existing connection when returning to the app or checking its health. Desktop foreground checks allow at least 15 seconds.",
    options: [3, 5, 10, 15, 30, 60],
  },
  {
    key: "heartbeatSeconds",
    label: "Heartbeat tolerance",
    description:
      "How long to wait for heartbeat replies before reconnecting. Automatic allows 15 seconds on desktop and 25 seconds on mobile. Applies to the next connection.",
    options: [0, 15, 25, 45, 60, 120],
  },
  {
    key: "retryMaxSeconds",
    label: "Maximum retry delay",
    description: "Maximum wait between repeated failed attempts. Retry now skips the wait.",
    options: [5, 15, 30, 60, 120, 300],
  },
] as const;

/** Client-local preferences remain accessible while every environment is offline. */
export class ConnectionTiming extends Context.Reference<{
  readonly get: Effect.Effect<ConnectionTimingSettings>;
  readonly changes: Stream.Stream<ConnectionTimingSettings>;
  readonly set: (settings: ConnectionTimingSettings) => Effect.Effect<void, ConnectionAttemptError>;
}>("@t3tools/client-runtime/connection/ConnectionTiming", {
  defaultValue: () => ({
    get: Effect.succeed(DEFAULT_CONNECTION_TIMING),
    changes: Stream.succeed(DEFAULT_CONNECTION_TIMING),
    set: () =>
      Effect.fail(
        new ConnectionBlockedError({
          reason: "unsupported",
          detail: "Connection timing settings are unavailable on this client.",
        }),
      ),
  }),
}) {}

export const makeConnectionTiming = Effect.fn("makeConnectionTiming")(function* (storage: {
  readonly read: Effect.Effect<ConnectionTimingSettings | undefined, ConnectionAttemptError>;
  readonly write: (
    settings: ConnectionTimingSettings,
  ) => Effect.Effect<void, ConnectionAttemptError>;
}) {
  const state = yield* SubscriptionRef.make((yield* storage.read) ?? DEFAULT_CONNECTION_TIMING);
  const lock = yield* Semaphore.make(1);
  return ConnectionTiming.of({
    get: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    set: (settings) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const decoded = yield* decodeTiming(settings).pipe(
            Effect.mapError(
              () =>
                new ConnectionBlockedError({
                  reason: "configuration",
                  detail:
                    "Connection timeouts must be whole seconds between 1 and 300; heartbeat may be 0 for automatic.",
                }),
            ),
          );
          yield* storage.write(decoded);
          yield* SubscriptionRef.set(state, decoded);
        }),
      ),
  });
});
