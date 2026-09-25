import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ApprovalRequestId,
  type OrchestrationReadModel,
  type OrchestrationSessionStatus,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-1");

function makeRequest(
  requestId: string,
  kind: "approval.requested" | "user-input.requested",
  responseMode?: "message",
): OrchestrationThreadActivity {
  return {
    id: EventId.make(requestId),
    kind,
    summary: "Question",
    tone: "approval",
    turnId: null,
    createdAt: NOW,
    payload: {
      requestId: ApprovalRequestId.make(requestId),
      ...(responseMode === undefined ? {} : { responseMode }),
      questions: [{ id: "0", header: "Q", question: "Continue?", options: [] }],
    },
  };
}

function makeReadModel(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        pullRequests: [],
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [...activities],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

function sessionSet(status: OrchestrationSessionStatus) {
  return {
    type: "thread.session.set" as const,
    commandId: CommandId.make(`session-${status}`),
    threadId,
    session: {
      threadId,
      status,
      providerName: "claudeAgent",
      runtimeMode: "full-access" as const,
      activeTurnId: null,
      lastError: null,
      updatedAt: NOW,
    },
    createdAt: NOW,
  };
}

const openRequests = [
  makeRequest("native-question", "user-input.requested"),
  makeRequest("approval", "approval.requested"),
  makeRequest("async-question", "user-input.requested", "message"),
];

it.layer(NodeServices.layer)("session end closes callback requests", (it) => {
  it.effect(
    "expires approvals and reopens native questions when the session can no longer answer",
    () =>
      Effect.gen(function* () {
        for (const status of ["starting", "stopped", "error"] as const) {
          const result = yield* decideOrchestrationCommand({
            command: sessionSet(status),
            readModel: makeReadModel(openRequests),
          });
          const events = Array.isArray(result) ? result : [result];
          expect(
            events.flatMap((event) =>
              event.type === "thread.activity-appended"
                ? [[event.payload.activity.kind, event.payload.activity.payload]]
                : [],
            ),
          ).toEqual([
            [
              "user-input.requested",
              {
                ...(openRequests[0]!.payload as Record<string, unknown>),
                requestId: "native-question",
                responseMode: "message",
              },
            ],
            ["approval.resolved", { requestId: "approval" }],
          ]);
        }
      }),
  );

  it.effect("dismisses questions when the user interrupts the turn", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: sessionSet("interrupted"),
        readModel: makeReadModel(openRequests),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(
        events.flatMap((event) =>
          event.type === "thread.activity-appended"
            ? [[event.payload.activity.kind, event.payload.activity.payload]]
            : [],
        ),
      ).toEqual([
        ["user-input.resolved", { requestId: "native-question" }],
        ["approval.resolved", { requestId: "approval" }],
      ]);
    }),
  );

  it.effect("answers a reopened question with a message to the agent", () =>
    Effect.gen(function* () {
      const ended = yield* decideOrchestrationCommand({
        command: sessionSet("error"),
        readModel: makeReadModel(openRequests),
      });
      const reopened = (Array.isArray(ended) ? ended : [ended]).flatMap((event) =>
        event.type === "thread.activity-appended" &&
        event.payload.activity.kind === "user-input.requested"
          ? [event.payload.activity]
          : [],
      )[0]!;
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.user-input.respond",
          commandId: CommandId.make("answer-1"),
          threadId,
          requestId: ApprovalRequestId.make("native-question"),
          answers: { "0": "Yes, go ahead" },
          createdAt: NOW,
        },
        readModel: makeReadModel([...openRequests, reopened]),
        userInputActivity: reopened,
      });
      const events = Array.isArray(result) ? result : [result];
      const message = events.find((event) => event.type === "thread.message-sent");
      expect(message?.payload).toMatchObject({ role: "user", text: "Continue?\nYes, go ahead" });
      expect(events.some((event) => event.type === "thread.user-input-response-requested")).toBe(
        false,
      );
    }),
  );

  it.effect("keeps requests open while the session is live", () =>
    Effect.gen(function* () {
      for (const status of ["running", "ready"] as const) {
        const result = yield* decideOrchestrationCommand({
          command: sessionSet(status),
          readModel: makeReadModel(openRequests),
        });
        const events = Array.isArray(result) ? result : [result];
        expect(events.map((event) => event.type)).toEqual(["thread.session-set"]);
      }
    }),
  );
});
