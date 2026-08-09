import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ServerConfig } from "../../config.ts";

/**
 * Statements issued through the tagged-template SQL client, newest last.
 *
 * The recording client below pushes here so a test can measure how much
 * database work one projected event costs.
 */
const recordedStatements: Array<string> = [];

/**
 * SQL client that records every statement the projectors build.
 *
 * Statements are recorded when they are constructed, which is one-to-one with
 * execution for the projection pipeline: every statement it builds is run.
 */
const RecordingSqlitePersistenceMemory = Layer.effect(
  SqlClient.SqlClient,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return new Proxy(sql, {
      apply(target, thisArg, args: ReadonlyArray<unknown>) {
        const [strings] = args;
        if (Array.isArray(strings) && "raw" in strings) {
          recordedStatements.push(strings.join("?"));
        }
        return Reflect.apply(target as never, thisArg, args as never);
      },
    });
  }),
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

const TestLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-projection-streaming-cost-test-" }),
  ),
  Layer.provideMerge(RecordingSqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

/** Tables whose per-thread collections must never be scanned for a text delta. */
const THREAD_COLLECTION_TABLES = [
  "projection_thread_messages",
  "projection_thread_activities",
  "projection_thread_proposed_plans",
  "projection_pending_approvals",
] as const;

const threadCollectionScans = (statements: ReadonlyArray<string>) =>
  statements.filter((statement) =>
    THREAD_COLLECTION_TABLES.some(
      (table) => statement.includes(`FROM ${table}`) && statement.includes("WHERE thread_id"),
    ),
  );

const DELTA_COUNT = 8;

it.layer(TestLayer)("OrchestrationProjectionPipeline streaming cost", (it) => {
  /**
   * Seed a thread with `historyLength` tool activities, then stream
   * {@link DELTA_COUNT} assistant text deltas into it, returning the statements
   * the deltas alone cost.
   */
  const measureStreamedDeltas = (input: {
    readonly slug: string;
    readonly historyLength: number;
  }) =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      const projectId = ProjectId.make(`project-${input.slug}`);
      const threadId = ThreadId.make(`thread-${input.slug}`);
      const at = (seconds: number) =>
        `2026-03-01T00:00:${String(seconds).padStart(2, "0")}.000Z` as const;

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make(`evt-${input.slug}-project`),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: at(0),
        commandId: CommandId.make(`cmd-${input.slug}-project`),
        causationEventId: null,
        correlationId: CorrelationId.make(`cmd-${input.slug}-project`),
        metadata: {},
        payload: {
          projectId,
          title: "Streaming cost",
          workspaceRoot: "/tmp/streaming-cost",
          defaultModelSelection: null,
          scripts: [],
          createdAt: at(0),
          updatedAt: at(0),
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make(`evt-${input.slug}-thread`),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: at(1),
        commandId: CommandId.make(`cmd-${input.slug}-thread`),
        causationEventId: null,
        correlationId: CorrelationId.make(`cmd-${input.slug}-thread`),
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "Streaming cost",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: at(1),
          updatedAt: at(1),
        },
      });

      // Thread history the old shell-summary refresh reloaded on every delta.
      yield* Effect.forEach(
        Array.from({ length: input.historyLength }, (_unused, index) => index),
        (index) =>
          appendAndProject({
            type: "thread.activity-appended",
            eventId: EventId.make(`evt-${input.slug}-activity-${index}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: at(2),
            commandId: CommandId.make(`cmd-${input.slug}-activity-${index}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-${input.slug}-activity-${index}`),
            metadata: {},
            payload: {
              threadId,
              activity: {
                id: EventId.make(`activity-${input.slug}-${index}`),
                tone: "info",
                kind: "tool.call",
                summary: `Ran tool ${index}`,
                payload: { index },
                turnId: null,
                createdAt: at(2),
              },
            },
          }),
        { concurrency: 1, discard: true },
      );

      recordedStatements.length = 0;
      yield* Effect.forEach(
        Array.from({ length: DELTA_COUNT }, (_unused, index) => index),
        (index) =>
          appendAndProject({
            type: "thread.message-sent",
            eventId: EventId.make(`evt-${input.slug}-delta-${index}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: at(3),
            commandId: CommandId.make(`cmd-${input.slug}-delta-${index}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-${input.slug}-delta-${index}`),
            metadata: {},
            payload: {
              threadId,
              messageId: MessageId.make(`message-${input.slug}`),
              role: "assistant",
              text: `chunk-${index} `,
              turnId: null,
              streaming: true,
              createdAt: at(3),
              updatedAt: at(3),
            },
          }),
        { concurrency: 1, discard: true },
      );
      return [...recordedStatements];
    });

  it.effect("projects assistant text deltas without scanning thread collections", () =>
    Effect.gen(function* () {
      const shallow = yield* measureStreamedDeltas({
        slug: "streaming-cost-shallow",
        historyLength: 4,
      });
      const deep = yield* measureStreamedDeltas({
        slug: "streaming-cost-deep",
        historyLength: 200,
      });

      assert.deepEqual(
        threadCollectionScans(deep),
        [],
        "assistant text deltas must not reload thread-wide collections",
      );

      // Projection cost per delta stays flat as thread history grows: N deltas
      // cost N times the same bounded set of keyed statements.
      assert.equal(deep.length, shallow.length);
      assert.equal(deep.length % DELTA_COUNT, 0);
    }),
  );

  it.effect("keeps assistant streaming text and thread summary correct", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      const projectId = ProjectId.make("project-streaming-text");
      const threadId = ThreadId.make("thread-streaming-text");
      const at = (seconds: number) =>
        `2026-03-02T00:00:${String(seconds).padStart(2, "0")}.000Z` as const;

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.make("evt-streaming-text-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: at(0),
        commandId: CommandId.make("cmd-streaming-text-project"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-streaming-text-project"),
        metadata: {},
        payload: {
          projectId,
          title: "Streaming text",
          workspaceRoot: "/tmp/streaming-text",
          defaultModelSelection: null,
          scripts: [],
          createdAt: at(0),
          updatedAt: at(0),
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.make("evt-streaming-text-thread"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: at(1),
        commandId: CommandId.make("cmd-streaming-text-thread"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-streaming-text-thread"),
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "Streaming text",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: at(1),
          updatedAt: at(1),
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-streaming-text-user"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: at(2),
        commandId: CommandId.make("cmd-streaming-text-user"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-streaming-text-user"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-streaming-text-user"),
          role: "user",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: at(2),
          updatedAt: at(2),
        },
      });

      yield* Effect.forEach(
        ["one ", "two ", "three"],
        (chunk, index) =>
          appendAndProject({
            type: "thread.message-sent",
            eventId: EventId.make(`evt-streaming-text-delta-${index}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: at(3 + index),
            commandId: CommandId.make(`cmd-streaming-text-delta-${index}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-streaming-text-delta-${index}`),
            metadata: {},
            payload: {
              threadId,
              messageId: MessageId.make("message-streaming-text-assistant"),
              role: "assistant",
              text: chunk,
              turnId: null,
              streaming: true,
              createdAt: at(3 + index),
              updatedAt: at(3 + index),
            },
          }),
        { concurrency: 1, discard: true },
      );

      // A later user message must still move latestUserMessageAt forward.
      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.make("evt-streaming-text-user-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: at(7),
        commandId: CommandId.make("cmd-streaming-text-user-2"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-streaming-text-user-2"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-streaming-text-user-2"),
          role: "user",
          text: "again",
          turnId: null,
          streaming: false,
          createdAt: at(7),
          updatedAt: at(7),
        },
      });

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly text: string;
        readonly isStreaming: number;
      }>`
        SELECT
          message_id AS "messageId",
          text,
          is_streaming AS "isStreaming"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `;
      assert.deepEqual(messageRows, [
        { messageId: "message-streaming-text-user", text: "hello", isStreaming: 0 },
        { messageId: "message-streaming-text-assistant", text: "one two three", isStreaming: 1 },
        { messageId: "message-streaming-text-user-2", text: "again", isStreaming: 0 },
      ]);

      const threadRows = yield* sql<{
        readonly latestUserMessageAt: string | null;
        readonly updatedAt: string;
      }>`
        SELECT
          latest_user_message_at AS "latestUserMessageAt",
          updated_at AS "updatedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(threadRows, [{ latestUserMessageAt: at(7), updatedAt: at(7) }]);
    }),
  );

  it.effect("rebuilds the same shell summary when projectors replay from the event log", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;

      const projectId = ProjectId.make("project-replay");
      const threadId = ThreadId.make("thread-replay");
      const turnId = TurnId.make("turn-replay");
      const at = (seconds: number) =>
        `2026-03-03T00:00:${String(seconds).padStart(2, "0")}.000Z` as const;

      // Appended but never projected: the projectors below have to derive the
      // whole summary from the event log, each with its own cursor.
      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-replay-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: at(0),
        commandId: CommandId.make("cmd-replay-project"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-replay-project"),
        metadata: {},
        payload: {
          projectId,
          title: "Replay",
          workspaceRoot: "/tmp/replay",
          defaultModelSelection: null,
          scripts: [],
          createdAt: at(0),
          updatedAt: at(0),
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("evt-replay-thread"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: at(1),
        commandId: CommandId.make("cmd-replay-thread"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-replay-thread"),
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "Replay",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: at(1),
          updatedAt: at(1),
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-replay-user"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: at(2),
        commandId: CommandId.make("cmd-replay-user"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-replay-user"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-replay-user"),
          role: "user",
          text: "plan it",
          turnId: null,
          streaming: false,
          createdAt: at(2),
          updatedAt: at(2),
        },
      });

      yield* eventStore.append({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-replay-approval"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: at(3),
        commandId: CommandId.make("cmd-replay-approval"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-replay-approval"),
        metadata: {},
        payload: {
          threadId,
          activity: {
            id: EventId.make("activity-replay-approval"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: { requestId: "approval-replay-1", requestKind: "command" },
            turnId,
            createdAt: at(3),
          },
        },
      });

      yield* eventStore.append({
        type: "thread.activity-appended",
        eventId: EventId.make("evt-replay-user-input"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: at(4),
        commandId: CommandId.make("cmd-replay-user-input"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-replay-user-input"),
        metadata: {},
        payload: {
          threadId,
          activity: {
            id: EventId.make("activity-replay-user-input"),
            tone: "info",
            kind: "user-input.requested",
            summary: "Provider asked a question",
            payload: { requestId: "user-input-replay-1" },
            turnId,
            createdAt: at(4),
          },
        },
      });

      // Assistant deltas between the summary-bearing events must not disturb
      // the replayed summary.
      yield* Effect.forEach(
        ["draft ", "answer"],
        (chunk, index) =>
          eventStore.append({
            type: "thread.message-sent",
            eventId: EventId.make(`evt-replay-delta-${index}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: at(5 + index),
            commandId: CommandId.make(`cmd-replay-delta-${index}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-replay-delta-${index}`),
            metadata: {},
            payload: {
              threadId,
              messageId: MessageId.make("message-replay-assistant"),
              role: "assistant",
              text: chunk,
              turnId,
              streaming: true,
              createdAt: at(5 + index),
              updatedAt: at(5 + index),
            },
          }),
        { concurrency: 1, discard: true },
      );

      yield* eventStore.append({
        type: "thread.proposed-plan-upserted",
        eventId: EventId.make("evt-replay-plan"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: at(7),
        commandId: CommandId.make("cmd-replay-plan"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-replay-plan"),
        metadata: {},
        payload: {
          threadId,
          proposedPlan: {
            id: "plan-replay-1",
            turnId,
            planMarkdown: "# Plan",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: at(7),
            updatedAt: at(7),
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const threadRows = yield* sql<{
        readonly latestUserMessageAt: string | null;
        readonly pendingApprovalCount: number;
        readonly pendingUserInputCount: number;
        readonly hasActionableProposedPlan: number;
      }>`
        SELECT
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(threadRows, [
        {
          latestUserMessageAt: at(2),
          pendingApprovalCount: 1,
          pendingUserInputCount: 1,
          hasActionableProposedPlan: 1,
        },
      ]);
    }),
  );
});
