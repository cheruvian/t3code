import type { OrchestrationV2AssistantMessageItem, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";

/** Live snippets have no persistence or replay cursor. Slow clients may miss them. */
export class AssistantPreviewBus extends Context.Service<
  AssistantPreviewBus,
  {
    readonly publish: (item: OrchestrationV2AssistantMessageItem) => Effect.Effect<void>;
    readonly subscribe: (
      threadId: ThreadId,
    ) => Effect.Effect<
      PubSub.Subscription<OrchestrationV2AssistantMessageItem>,
      never,
      Scope.Scope
    >;
  }
>()("t3/orchestration-v2/AssistantPreviewBus") {}

export const layer = Layer.effect(
  AssistantPreviewBus,
  Effect.gen(function* () {
    const subscribers = new Map<
      ThreadId,
      { bus: PubSub.PubSub<OrchestrationV2AssistantMessageItem>; count: number }
    >();
    return AssistantPreviewBus.of({
      publish: (item) =>
        Effect.suspend(() => {
          const entry = subscribers.get(item.threadId);
          return entry ? PubSub.publish(entry.bus, item).pipe(Effect.asVoid) : Effect.void;
        }),
      subscribe: (threadId) =>
        Effect.gen(function* () {
          const entry = yield* Effect.acquireRelease(
            Effect.gen(function* () {
              let entry = subscribers.get(threadId);
              if (!entry) {
                entry = {
                  bus: yield* PubSub.sliding<OrchestrationV2AssistantMessageItem>(64),
                  count: 0,
                };
                subscribers.set(threadId, entry);
              }
              entry.count++;
              return entry;
            }),
            (entry) =>
              Effect.suspend(() => {
                if (--entry.count !== 0) return Effect.void;
                subscribers.delete(threadId);
                return PubSub.shutdown(entry.bus);
              }),
          );
          return yield* PubSub.subscribe(entry.bus);
        }),
    });
  }),
);
