import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

const layerTest = ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer));

function importedItem(
  input:
    | {
        readonly role: "user";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      }
    | {
        readonly role: "assistant";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      },
): OrchestrationV2TurnItem {
  const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  const base = {
    id: TurnItemId.make(`turn-item:${input.id}`),
    threadId: ThreadId.make("thread:legacy-context"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    messageId: MessageId.make(`message:${input.id}`),
    text: input.text,
  };
  return input.role === "user"
    ? {
        ...base,
        createdBy: "user",
        creationSource: "server",
        type: "user_message",
        inputIntent: "turn_start",
        attachments: [],
      }
    : {
        ...base,
        type: "assistant_message",
        streaming: false,
      };
}

it.layer(layerTest)("ContextHandoffService legacy import", (it) => {
  it.effect("prepares imported history for the first native v2 turn", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({ role: "user", id: "one", text: "What did we decide?", ordinal: 1 }),
          importedItem({
            role: "assistant",
            id: "two",
            text: "We decided to keep the migration lightweight.",
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.equal(handoff.strategy, "manual_context");
      assert.deepStrictEqual(handoff.fromProviderThreadIds, []);
      assert.include(handoff.summaryText, "What did we decide?");
      assert.include(handoff.summaryText, "keep the migration lightweight");
      const providerMessage = ContextHandoffService.providerMessageWithContextHandoff({
        handoff,
        userText: "Continue from there.",
      });
      assert.include(providerMessage, handoff.summaryText);
      assert.include(providerMessage, "User message:\nContinue from there.");
    }),
  );

  it.effect("preserves role attribution when truncating imported history", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "user",
            id: "long",
            text: `${"x".repeat(35_000)} retained final words`,
            ordinal: 1,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... retained final words");
      assert.notMatch(handoff.summaryText, /\n+x+ retained final words/);
    }),
  );

  it.effect("retains the newest oversized import even when it has no whitespace", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "assistant",
            id: "older",
            text: "older message",
            ordinal: 1,
          }),
          importedItem({
            role: "user",
            id: "long-single-token",
            text: `${"🧪".repeat(20_000)}LATEST_SINGLE_TOKEN`,
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.include(
        handoff.history?.omittedItemIds ?? [],
        TurnItemId.make("turn-item:long-single-token"),
      );
      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... ");
      assert.include(handoff.summaryText, "LATEST_SINGLE_TOKEN");
      assert.notInclude(handoff.summaryText, "\ufffd");
    }),
  );
});

it.effect(
  "recovery after a context reset excludes older history and retains subsequent replies",
  () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const now = DateTime.makeUnsafe("2026-01-02T00:00:00.000Z");
      const threadId = ThreadId.make("thread:legacy-context");
      const instanceId = ProviderInstanceId.make("codex");
      const providerThreadId = ProviderThreadId.make("provider-thread:reset");
      const runs = [1, 2, 3].map((ordinal) => ({
        id: RunId.make(`run:reset:${ordinal}`),
        threadId,
        ordinal,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "gpt-5.4" },
        providerThreadId,
        userMessageId: MessageId.make(`message:reset:${ordinal}`),
        rootNodeId: NodeId.make(`node:reset:${ordinal}`),
        activeAttemptId: null,
        status: "completed" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      }));
      const input = {
        threadId,
        targetRunId: RunId.make("run:reset:4"),
        transferId: null,
        fromProviderThreadIds: [providerThreadId],
        toProviderThreadId: providerThreadId,
        fromProviderInstanceId: instanceId,
        toProviderInstanceId: instanceId,
        coveredRunOrdinals: { from: 1, to: 3 },
        strategy: "full_thread_summary" as const,
        runs,
        contextResetRunOrdinal: 2,
        items: [
          importedItem({
            role: "assistant",
            id: "legacy-secret",
            text: "LEGACY-SECRET",
            ordinal: 1,
          }),
          ...["BEFORE-RESET-SECRET", "/clear", "AFTER-RESET-REPLY"].map((text, i) => ({
            ...importedItem({ role: "assistant", id: `reset:${i}`, text, ordinal: i + 2 }),
            runId: runs[i]!.id,
          })),
        ],
        createdAt: now,
      };
      const handoff = yield* service.prepareProviderHandoff(input);
      assert.notInclude(handoff.summaryText, "BEFORE-RESET-SECRET");
      assert.notInclude(handoff.summaryText, "LEGACY-SECRET");
      assert.notInclude(handoff.summaryText, "/clear");
      assert.include(handoff.summaryText, "AFTER-RESET-REPLY");
      const ordinary = yield* service.prepareProviderHandoff({
        ...input,
        contextResetRunOrdinal: undefined,
      });
      assert.include(ordinary.summaryText, "BEFORE-RESET-SECRET");
      assert.include(ordinary.summaryText, "LEGACY-SECRET");
    }).pipe(Effect.provide(layerTest)),
);

it.each([
  {
    name: "completed root reset",
    child: false,
    rolledBack: false,
    earlierReset: false,
    expected: 2,
  },
  { name: "child reset", child: true, rolledBack: false, earlierReset: false, expected: undefined },
  {
    name: "rolled-back root reset",
    child: false,
    rolledBack: true,
    earlierReset: false,
    expected: undefined,
  },
  {
    name: "earlier reset survives rollback of a later reset",
    child: false,
    rolledBack: true,
    earlierReset: true,
    expected: 1,
  },
])(
  "uses only an effective root reset boundary: $name",
  ({ child, rolledBack, earlierReset, expected }) => {
    const now = DateTime.makeUnsafe("2026-01-02T00:00:00.000Z");
    const threadId = ThreadId.make("thread:reset-boundary");
    const instanceId = ProviderInstanceId.make("codex");
    const providerThreadId = ProviderThreadId.make("provider-thread:reset-boundary");
    const rootNodeId = NodeId.make("node:reset-boundary");
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: instanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: child ? rootNodeId : null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 2,
      contextResetRunOrdinals: earlierReset ? [1, 2] : [2],
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    };
    const run: OrchestrationV2Run = {
      id: RunId.make("run:reset-boundary"),
      threadId,
      ordinal: 2,
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-5.4" },
      providerThreadId,
      userMessageId: MessageId.make("message:reset-boundary"),
      rootNodeId,
      activeAttemptId: null,
      status: rolledBack ? "rolled_back" : "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    };
    assert.equal(
      ContextHandoffService.contextResetRunOrdinal(
        [providerThread],
        [
          ...(earlierReset
            ? [
                {
                  ...run,
                  id: RunId.make("run:earlier-reset"),
                  ordinal: 1,
                  status: "completed" as const,
                },
              ]
            : []),
          run,
        ],
      ),
      expected,
    );
  },
);
