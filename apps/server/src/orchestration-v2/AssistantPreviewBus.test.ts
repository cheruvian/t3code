import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AssistantMessageItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as AssistantPreviewBus from "./AssistantPreviewBus.ts";

const threadId = ThreadId.make("preview-thread");
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
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-10-15T00:00:00Z"),
  type: "assistant_message",
  messageId: MessageId.make("preview-message"),
  text: "First words",
  streaming: true,
};

it.effect("fans out only to attached readers of that thread and does not replay old snippets", () =>
  Effect.gen(function* () {
    const bus = yield* AssistantPreviewBus.AssistantPreviewBus;
    yield* bus.publish(item);
    const first = yield* bus.subscribe(threadId);
    const second = yield* bus.subscribe(threadId);
    const other = yield* bus.subscribe(ThreadId.make("other-thread"));
    assert.equal(yield* PubSub.remaining(first), 0);
    yield* bus.publish(item);
    assert.deepEqual(yield* PubSub.take(first), item);
    assert.deepEqual(yield* PubSub.take(second), item);
    assert.equal(yield* PubSub.remaining(other), 0);
    const late = yield* bus.subscribe(threadId);
    assert.equal(yield* PubSub.remaining(late), 0);
  }).pipe(Effect.scoped, Effect.provide(AssistantPreviewBus.layer)),
);

it.effect("bounds slow readers and detaches them without losing another reader", () =>
  Effect.gen(function* () {
    const bus = yield* AssistantPreviewBus.AssistantPreviewBus;
    const firstScope = yield* Scope.make();
    const first = yield* Scope.provide(bus.subscribe(threadId), firstScope);
    const second = yield* bus.subscribe(threadId);
    for (let i = 0; i < 100; i++) yield* bus.publish({ ...item, text: String(i) });
    assert.equal(yield* PubSub.remaining(first), 64);
    assert.equal(yield* PubSub.remaining(second), 64);
    yield* Scope.close(firstScope, Exit.void);
    yield* bus.publish({ ...item, text: "still attached" });
    const last = yield* PubSub.takeAll(second);
    assert.equal(last.at(-1)?.text, "still attached");
  }).pipe(Effect.scoped, Effect.provide(AssistantPreviewBus.layer)),
);
