import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import {
  AssistantPreviewBus,
  type AssistantPreviewBusShape,
  type AssistantPreviewPublication,
} from "../Services/AssistantPreviewBus.ts";

const make = Effect.gen(function* () {
  const pubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<AssistantPreviewPublication>(),
    PubSub.shutdown,
  );

  return AssistantPreviewBus.of({
    publish: (publication) => PubSub.publish(pubSub, publication).pipe(Effect.asVoid),
    get stream() {
      return Stream.fromPubSub(pubSub);
    },
  } satisfies AssistantPreviewBusShape);
});

export const AssistantPreviewBusLive = Layer.effect(AssistantPreviewBus, make);
