/**
 * RuntimeReceiptBus layers.
 *
 * `RuntimeReceiptBusLive` is the in-memory broadcast used to coordinate live
 * reactors. `RuntimeReceiptBusNoop` is available to isolated consumers that do
 * not coordinate on receipts. `RuntimeReceiptBusTest` exposes the same
 * PubSub-backed behavior for integration tests that await exact milestones.
 *
 * @module RuntimeReceiptBus
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import {
  RuntimeReceiptBus,
  type RuntimeReceiptBusShape,
  type OrchestrationRuntimeReceipt,
} from "../Services/RuntimeReceiptBus.ts";

const makeRuntimeReceiptBusNoop = Effect.succeed({
  publish: () => Effect.void,
  streamReceipts: Stream.empty,
  streamEventsForTest: Stream.empty,
} satisfies RuntimeReceiptBusShape);

const makeRuntimeReceiptBusBroadcast = Effect.gen(function* () {
  const pubSub = yield* PubSub.unbounded<OrchestrationRuntimeReceipt>();

  return {
    publish: (receipt) => PubSub.publish(pubSub, receipt).pipe(Effect.asVoid),
    get streamReceipts() {
      return Stream.fromPubSub(pubSub);
    },
    get streamEventsForTest() {
      return Stream.fromPubSub(pubSub);
    },
  } satisfies RuntimeReceiptBusShape;
});

export const RuntimeReceiptBusLive = Layer.effect(
  RuntimeReceiptBus,
  makeRuntimeReceiptBusBroadcast,
);
export const RuntimeReceiptBusNoop = Layer.effect(RuntimeReceiptBus, makeRuntimeReceiptBusNoop);
export const RuntimeReceiptBusTest = Layer.effect(
  RuntimeReceiptBus,
  makeRuntimeReceiptBusBroadcast,
);
