import type { ServerDrainSnapshot, ServerLifecycleStreamEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

type LifecycleEventInput =
  | Omit<Extract<ServerLifecycleStreamEvent, { type: "welcome" }>, "sequence">
  | Omit<Extract<ServerLifecycleStreamEvent, { type: "ready" }>, "sequence">;

interface SnapshotState {
  readonly sequence: number;
  readonly events: ReadonlyArray<ServerLifecycleStreamEvent>;
}

export class ServerLifecycleEvents extends Context.Service<
  ServerLifecycleEvents,
  {
    readonly publish: (event: LifecycleEventInput) => Effect.Effect<ServerLifecycleStreamEvent>;
    readonly setDrain: (
      drain: ServerDrainSnapshot | undefined,
    ) => Effect.Effect<ServerLifecycleStreamEvent | undefined>;
    readonly snapshot: Effect.Effect<SnapshotState>;
    readonly stream: Stream.Stream<ServerLifecycleStreamEvent>;
  }
>()("t3/serverLifecycleEvents") {}

const make = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<ServerLifecycleStreamEvent>();
  const state = yield* Ref.make<SnapshotState>({
    sequence: 0,
    events: [],
  });
  const pendingDrain = yield* Ref.make<ServerDrainSnapshot | undefined>(undefined);

  const publish = (event: LifecycleEventInput) =>
    Effect.gen(function* () {
      const drain = yield* Ref.get(pendingDrain);
      return yield* Ref.modify(state, (current) => {
        const nextSequence = current.sequence + 1;
        const nextEvent: ServerLifecycleStreamEvent =
          event.type === "welcome"
            ? { ...event, sequence: nextSequence }
            : {
                ...event,
                sequence: nextSequence,
                payload: {
                  ...event.payload,
                  ...(drain === undefined ? {} : { drain }),
                },
              };
        const nextEvents: ReadonlyArray<ServerLifecycleStreamEvent> =
          nextEvent.type === "welcome"
            ? [nextEvent, ...current.events.filter((entry) => entry.type !== "welcome")]
            : [nextEvent, ...current.events.filter((entry) => entry.type !== "ready")];
        return [nextEvent, { sequence: nextSequence, events: nextEvents }] as const;
      });
    }).pipe(Effect.tap((event) => PubSub.publish(pubsub, event)));

  return {
    publish,
    setDrain: (drain) =>
      Ref.set(pendingDrain, drain).pipe(
        Effect.andThen(Ref.get(state)),
        Effect.flatMap((current) => {
          const ready = current.events.find((event) => event.type === "ready");
          if (ready === undefined) return Effect.succeed(undefined);
          return publish({
            version: 1,
            type: "ready",
            payload: Object.fromEntries(
              Object.entries(ready.payload).filter(([key]) => key !== "drain"),
            ) as typeof ready.payload,
          });
        }),
      ),
    snapshot: Ref.get(state),
    get stream() {
      return Stream.fromPubSub(pubsub);
    },
  } satisfies ServerLifecycleEvents["Service"];
});

export const layer = Layer.effect(ServerLifecycleEvents, make);
