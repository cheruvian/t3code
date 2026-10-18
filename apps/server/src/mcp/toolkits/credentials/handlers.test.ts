import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  ThreadId,
  ProviderInstanceId,
  type CredentialCaller,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as CredentialBroker from "../../../secrets/CredentialBroker.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell, idleThreadProjection } from "../../McpToolAccess.testkit.ts";

const threadId = ThreadId.make("actual-thread");
const caller = { ...liveThreadShell(threadId), worktreePath: "/actual/worktree" };
const input = {
  site: "example.com",
  label: "claimed-thread-name",
  reason: "Sign in",
  field: "login" as const,
  ttlSeconds: 60,
  argv: ["/usr/bin/consumer"],
};
const invocation = {
  environmentId: EnvironmentId.make("actual-environment"),
  requestNamespace: "actual-session",
  thread: {
    threadId,
    providerSessionId: "actual-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration" as const]),
};

it("forwards only known broker failure codes and suppresses arbitrary provider errors", () => {
  const marker = "fake-secret-provider-output";
  const locked = CredentialBroker.safeBrokerFailure({ code: "vault_locked", message: marker });
  expect(locked.code).toBe("vault_locked");
  expect(locked.message).toContain("unlock the vault privately");
  const unavailable = CredentialBroker.safeBrokerFailure({
    code: "consumer_unavailable",
    message: marker,
  });
  expect(unavailable.code).toBe("consumer_unavailable");
  expect(unavailable.message).toContain("No vault search or approval was started");
  expect(unavailable.message).not.toContain(marker);
  for (const error of [new Error(marker), { code: marker, message: marker }]) {
    const failure = CredentialBroker.safeBrokerFailure(error);
    expect(failure.code).toBe("broker_unavailable");
    expect(JSON.stringify(failure)).not.toContain(marker);
    expect(failure.message).not.toContain(marker);
  }
});

it.effect(
  "uses authenticated thread identity and cancels the exact invocation on a committed thread stop",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
        const started = yield* Deferred.make<CredentialCaller>();
        const cleaned = yield* Deferred.make<void>();
        const dependencies = Layer.mergeAll(
          Layer.succeed(McpInvocationContext.McpInvocationContext, invocation),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(caller),
            getThreadEventSequence: () => Effect.succeed(7),
            streamStoredEventsFrom: () => Stream.fromQueue(events),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getShell: () =>
              Effect.succeed(
                Option.some({
                  id: caller.projectId,
                  title: "Project",
                  workspaceRoot: "/project/root",
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-01-01T00:00:00Z",
                  updatedAt: "2026-01-01T00:00:00Z",
                }),
              ),
          }),
          Layer.mock(CredentialBroker.CredentialBroker)({
            execute: (identity) =>
              Deferred.succeed(started, identity).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(cleaned, undefined)),
              ),
          }),
          NodeServices.layer,
        );
        yield* Effect.gen(function* () {
          const threads = yield* ThreadManagement.ThreadManagementService;
          const locked = yield* CredentialBroker.bindToolCall(input, () =>
            Effect.fail(
              CredentialBroker.safeBrokerFailure({ code: "vault_locked", message: "fake-secret" }),
            ),
          ).pipe(
            Effect.provideService(ThreadManagement.ThreadManagementService, {
              ...threads,
              streamStoredEventsFrom: () => Stream.never,
            }),
            Effect.flip,
          );
          expect(locked).toMatchObject({ code: "credential_broker_error" });
          expect(locked.message).toContain("unlock the vault privately");
          expect(locked.message).not.toContain("fake-secret");
          const broker = yield* CredentialBroker.CredentialBroker;
          const execution = yield* CredentialBroker.bindToolCall(input, broker.execute).pipe(
            Effect.forkChild,
          );
          const identity = yield* Deferred.await(started);
          expect(identity).toMatchObject({
            ...invocation.thread,
            environmentId: invocation.environmentId,
            threadTitle: caller.title,
            runId: caller.activeRunId,
            workspace: "/actual/worktree",
            agent: "gpt-5",
          });
          expect(identity.toolCallId).toMatch(/^[a-f0-9-]{36}$/);
          expect(identity.threadTitle).not.toBe(input.label);
          yield* Queue.offer(events, {
            sequence: 8,
            commandId: null,
            event: {
              id: EventId.make("event:stop"),
              threadId,
              occurredAt: DateTime.makeUnsafe("2026-01-01T00:00:01Z"),
              type: "thread.archived",
              payload: idleThreadProjection(caller).thread,
            },
          });
          const result = yield* Fiber.join(execution).pipe(Effect.flip);
          expect(result).toMatchObject({ code: "credential_broker_error" });
          yield* Deferred.await(cleaned);
        }).pipe(Effect.provide(dependencies));
      }),
    ),
);
