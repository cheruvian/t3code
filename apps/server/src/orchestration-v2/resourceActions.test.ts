import {
  CommandId,
  ProjectId,
  ThreadId,
  RunId,
  type OrchestrationV2StoredEvent,
  type ProjectResourceLock,
  type ResourceActionLog,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  type ApplicationStoredEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ProcessRunner, type ProcessRunInput, type ProcessRunOutput } from "../processRunner.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { OrchestrationEventStore } from "../persistence/OrchestrationEventStore.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as ResourceActions from "./ResourceActionReactor.ts";
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("owner");
const lock: ProjectResourceLock = {
  threadId,
  operationId: CommandId.make("checkout"),
  phase: "checkout",
  script: {
    id: "device",
    name: "Device",
    command: "checkout-device",
    icon: "configure",
    runOnWorktreeCreate: false,
    resource: {
      color: "#abcdef",
      checkoutPrompt: "",
      releaseCommand: "release-device",
      releasePrompt: "",
    },
  },
};
const harness = (
  options: {
    restart?: boolean;
    block?: boolean;
    fail?: boolean;
    prompt?: "completed" | "failed";
  } = {},
) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ApplicationStoredEvent>();
    const logs = yield* Queue.unbounded<ResourceActionLog>();
    const scripts = yield* Queue.unbounded<ProcessRunInput>();
    const completed = yield* Queue.unbounded<string | undefined>();
    const interrupted = yield* Queue.unbounded<void>();
    let locks = options.restart ? [lock] : [];
    let resumed = 0;
    const prompts: unknown[] = [];
    const terminalEvents: OrchestrationV2StoredEvent[] = [];
    const shell = () =>
      ({
        id: projectId,
        workspaceRoot: "/workspace",
        resourceLocks: locks,
      }) as unknown as OrchestrationProjectShell;
    const dependencies = Layer.mergeAll(
      Layer.mock(ProjectService)({
        getShell: () => Effect.sync(() => Option.some(shell())),
        listShells: () => Effect.sync(() => [shell()]),
        resourceComplete: (input) =>
          Effect.gen(function* () {
            yield* Queue.offer(completed, input.error);
            return shell() as never;
          }),
      }),
      Layer.mock(ProjectionStoreV2)({
        getThreadShell: () =>
          Effect.succeed({ id: threadId, worktreePath: "/worktree" } as OrchestrationV2ThreadShell),
      }),
      Layer.mock(OrchestrationEventStore)({
        latestApplicationSequence: Effect.succeed(0),
        streamApplicationEvents: () => Stream.fromQueue(events),
      }),
      Layer.mock(EventSinkV2)({
        latestSequence: () => Effect.succeed(0),
        stream: () => Stream.fromIterable(terminalEvents),
        write: (input) =>
          Effect.gen(function* () {
            for (const event of input.events)
              if (
                event.type === "turn-item.updated" &&
                event.payload.type === "command_execution" &&
                event.payload.resourceActionLog
              )
                yield* Queue.offer(logs, event.payload.resourceActionLog);
            return [];
          }),
      }),
      Layer.mock(OrchestratorV2)({
        resumeQueuedRuns: Effect.sync(() => ++resumed),
        dispatch: (command) =>
          Effect.sync(() => {
            prompts.push(command);
            const run = { id: RunId.make("resource-run"), status: options.prompt ?? "completed" };
            terminalEvents.push({
              event: { type: "run.updated", payload: run },
            } as OrchestrationV2StoredEvent);
            return {
              sequence: 1,
              storedEvents: [
                { event: { type: "run.created", payload: run } } as OrchestrationV2StoredEvent,
              ],
            };
          }),
      }),
      Layer.mock(ProcessRunner)({
        run: (input) =>
          Effect.gen(function* () {
            yield* Queue.offer(scripts, input);
            if (options.block) {
              input.onStdoutChunk?.(new TextEncoder().encode("x".repeat(20000)));
              return yield* Effect.never.pipe(
                Effect.onInterrupt(() => Queue.offer(interrupted, undefined)),
              );
            }
            return {
              stdout: "done",
              stderr: "",
              code: (options.fail ? 1 : 0) as ProcessRunOutput["code"],
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      }),
      Layer.succeed(HostProcessEnvironment, {}),
      Layer.succeed(HostProcessPlatform, "linux"),
    );
    const reactor = yield* ResourceActions.make.pipe(Effect.provide(dependencies));
    const publish = (entry: ProjectResourceLock, commandId = entry.operationId) =>
      Effect.gen(function* () {
        locks = [entry];
        yield* Queue.offer(events, {
          type: "project.meta-updated",
          commandId,
          payload: { projectId, resourceLocks: locks },
        } as unknown as ApplicationStoredEvent);
      });
    return {
      reactor,
      publish,
      scripts,
      completed,
      logs,
      interrupted,
      prompts,
      resumed: () => resumed,
    };
  });
it.layer(NodeServices.layer)("resource action reactor V2", (it) => {
  it.effect("runs checkout in the worktree and resumes queued runs", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.reactor.start();
      yield* h.publish(lock);
      expect(yield* Queue.take(h.scripts)).toMatchObject({
        cwd: "/worktree",
        env: { T3CODE_PROJECT_ROOT: "/workspace", T3CODE_THREAD_ID: threadId },
      });
      expect(yield* Queue.take(h.completed)).toBeUndefined();
      yield* h.reactor.drain;
      expect(h.resumed()).toBe(1);
    }),
  );
  it.effect.each(["completed", "failed"] as const)(
    "observes a prompt %s during dispatch",
    (status) =>
      Effect.gen(function* () {
        const h = yield* harness({ prompt: status });
        yield* h.reactor.start();
        yield* h.publish({
          ...lock,
          script: {
            ...lock.script,
            resource: { ...lock.script.resource!, checkoutPrompt: "Prepare device" },
          },
        });
        const error = yield* Queue.take(h.completed);
        if (status === "completed") expect(error).toBeUndefined();
        else expect(error).toContain("did not finish successfully");
        expect(h.prompts[0]).toMatchObject({
          type: "message.dispatch",
          resourceOperationId: lock.operationId,
          createdBy: "system",
          creationSource: "server",
        });
      }),
  );
  it.effect("uses release hooks and reports shell failure", () =>
    Effect.gen(function* () {
      const h = yield* harness({ fail: true });
      yield* h.reactor.start();
      yield* h.publish({ ...lock, phase: "release" });
      expect((yield* Queue.take(h.scripts)).args).toContain("release-device");
      expect(yield* Queue.take(h.completed)).toContain("exited with 1");
    }),
  );
  it.effect("bounds live output and aborts shell execution", () =>
    Effect.gen(function* () {
      const h = yield* harness({ block: true });
      yield* h.reactor.start();
      yield* h.publish(lock);
      yield* Queue.take(h.scripts);
      yield* Queue.take(h.logs);
      yield* TestClock.adjust("1 second");
      const running = yield* Queue.take(h.logs);
      expect(running.truncated).toBe(true);
      expect(running.stdout.length).toBe(16384);
      yield* h.publish({ ...lock, cancelRequested: true }, CommandId.make("abort"));
      yield* Queue.take(h.interrupted);
      expect(yield* Queue.take(h.completed)).toContain("aborted");
      expect((yield* Queue.take(h.logs)).status).toBe("failed");
    }),
  );
  it.effect("fails restart hooks without rerunning external effects", () =>
    Effect.gen(function* () {
      const h = yield* harness({ restart: true });
      yield* h.reactor.start();
      expect(yield* Queue.take(h.completed)).toContain("Server restarted");
      expect((yield* Queue.take(h.logs)).status).toBe("failed");
      expect(yield* Queue.size(h.scripts)).toBe(0);
    }),
  );
});
