import * as TestClock from "effect/testing/TestClock";
import * as Duration from "effect/Duration";
import { resourceActionLogs } from "@t3tools/shared/resourceActions";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { resolveInheritedProjectScripts } from "@t3tools/shared/projectScripts";
import * as Crypto from "effect/Crypto";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type ProjectScript,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ProcessRunner, type ProcessRunInput, type ProcessRunOutput } from "../processRunner.ts";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ResourceActions from "./ResourceActionReactor.ts";

const now = "2026-09-21T10:00:00.000Z";
const projectId = ProjectId.make("project");
const owner = ThreadId.make("owner");
const other = ThreadId.make("other");
const script: ProjectScript = {
  id: "device",
  name: "Test device",
  command: "checkout-device",
  icon: "configure",
  runOnWorktreeCreate: false,
  resource: {
    color: "#3b82f6",
    checkoutPrompt: "Prepare the device",
    releaseCommand: "release-device",
    releasePrompt: "Clean up the device",
  },
};
const output = (code = 0): ProcessRunOutput => ({
  stdout: "script output",
  stderr: code ? "cleanup failed" : "",
  code: code as ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const harness = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  let state = createEmptyReadModel(now);
  let sequence = 0;
  let id = 0;
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  const completions = yield* Queue.unbounded<OrchestrationCommand>();
  const prompts = yield* Queue.unbounded<OrchestrationCommand>();
  const turnInterrupts = yield* Queue.unbounded<OrchestrationCommand>();
  const scripts = yield* Queue.unbounded<ProcessRunInput>();
  let scriptCode = 0;
  let blockScript = false;
  const interrupted = yield* Queue.unbounded<void>();
  const dispatch = Effect.fn(function* (command: OrchestrationCommand) {
    const result = yield* decideOrchestrationCommand({ readModel: state, command });
    for (const pending of Array.isArray(result) ? result : [result]) {
      const event = { ...pending, sequence: ++sequence };
      state = yield* projectEvent(state, event);
      yield* PubSub.publish(events, event);
    }
    if (command.type === "project.resource.complete") yield* Queue.offer(completions, command);
    if (command.type === "thread.turn.interrupt") yield* Queue.offer(turnInterrupts, command);
    if (command.type === "thread.turn.start") yield* Queue.offer(prompts, command);
    return { sequence };
  });
  const nextId = () => CommandId.make(`cmd-${++id}`);
  yield* dispatch({
    type: "project.create",
    commandId: nextId(),
    projectId,
    title: "Resources",
    workspaceRoot: "/workspace",
    createdAt: now,
  });
  for (const threadId of [owner, other])
    yield* dispatch({
      type: "thread.create",
      commandId: nextId(),
      projectId,
      threadId,
      title: threadId,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: now,
    });
  const request = (
    action: "checkout" | "takeover" | "release" | "force-release" | "abort",
    threadId = owner,
    actionScript = script,
    expectedOperationId?: CommandId,
  ) =>
    dispatch({
      type: "project.resource.request",
      commandId: nextId(),
      projectId,
      threadId,
      script: actionScript,
      action,
      ...(expectedOperationId ? { expectedOperationId } : {}),
    });
  const session = (status: "running" | "ready" | "error") =>
    dispatch({
      type: "thread.session.set",
      commandId: nextId(),
      threadId: owner,
      createdAt: now,
      session: {
        threadId: owner,
        status,
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: status === "running" ? TurnId.make("turn") : null,
        lastError: null,
        updatedAt: now,
      },
    });
  const dependencies = Layer.mergeAll(
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        dispatch(command).pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.orDie),
      subscribeDomainEvents: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getProjectShellById: (id) =>
        Effect.sync(() => Option.fromNullishOr(state.projects.find((p) => p.id === id))),
      getThreadShellById: (id) =>
        Effect.sync(() =>
          Option.fromNullishOr(state.threads.find((t) => t.id === id)).pipe(
            Option.map((t) => ({
              ...t,
              latestUserMessageAt: null,
              hasPendingApprovals: false,
              hasPendingUserInput: false,
              hasActionableProposedPlan: false,
            })),
          ),
        ),
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: sequence,
          projects: state.projects,
          threads: [],
          updatedAt: now,
        }),
    }),
    Layer.mock(ProcessRunner)({
      run: (input) =>
        Effect.gen(function* () {
          yield* Queue.offer(scripts, input);
          if (blockScript) {
            input.onStdoutChunk?.(new TextEncoder().encode("Deployment in progress"));
            input.onStderrChunk?.(new TextEncoder().encode("Retrying upload"));
            return yield* Effect.never.pipe(
              Effect.onInterrupt(() => Queue.offer(interrupted, undefined)),
            );
          }
          return output(scriptCode);
        }),
    }),
    Layer.succeed(HostProcessEnvironment, {}),
    Layer.succeed(HostProcessPlatform, "linux"),
  );
  const reactor = yield* ResourceActions.make.pipe(Effect.provide(dependencies));
  return {
    dispatch,
    nextId,
    request,
    session,
    reactor,
    scripts,
    prompts,
    turnInterrupts,
    completions,
    interrupted,
    holdScript: () => {
      blockScript = true;
    },
    logs: () =>
      resourceActionLogs(state.threads.find((thread) => thread.id === owner)?.activities ?? []),
    locks: () => state.projects[0]!.resourceLocks ?? [],
    failScript: () => {
      scriptCode = 1;
    },
  };
});

it.layer(NodeServices.layer)("resource actions", (it) => {
  it.effect("aborts a resource prompt through the provider interrupt command", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.reactor.start();
      yield* h.request("checkout");
      yield* Queue.take(h.prompts);
      yield* h.session("running");
      yield* h.request("abort", owner, script, h.locks()[0]!.operationId);
      expect(yield* Queue.take(h.turnInterrupts)).toMatchObject({
        type: "thread.turn.interrupt",
        threadId: owner,
      });
      yield* Queue.take(h.completions);
      yield* h.reactor.drain;
      expect(h.logs()[0]).toMatchObject({
        status: "failed",
        error: expect.stringContaining("aborted"),
      });
      expect(h.locks()[0]?.phase).toBe("failed");
    }),
  );

  it.effect(
    "allows long scripts and aborts them while retaining captured output and ownership",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        h.holdScript();
        yield* h.reactor.start();
        yield* h.request("checkout");
        const input = yield* Queue.take(h.scripts);
        expect(Duration.isFinite(Duration.fromInputUnsafe(input.timeout!))).toBe(false);
        yield* TestClock.adjust("20 minutes");
        expect(h.locks()[0]?.phase).toBe("checkout");
        const operation = h.locks()[0]!.operationId;
        expect(
          (yield* Effect.flip(h.request("abort", other, script, operation))).message,
        ).toContain("held by thread");
        expect(
          (yield* Effect.flip(h.request("abort", owner, script, h.nextId()))).message,
        ).toContain("finished or changed");
        yield* h.request("abort", owner, script, operation);
        yield* Queue.take(h.interrupted);
        yield* Queue.take(h.completions);
        yield* h.reactor.drain;
        expect(h.locks()[0]).toMatchObject({
          phase: "failed",
          error: expect.stringContaining("aborted"),
        });
        expect(h.logs()[0]).toMatchObject({
          status: "failed",
          stdout: "Deployment in progress",
          stderr: "Retrying upload",
          error: expect.stringContaining("aborted"),
        });
        expect(
          (yield* Effect.flip(h.request("abort", owner, script, operation))).message,
        ).toContain("finished or changed");
      }),
  );

  it.effect("checks out and releases an inherited file resource", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const file = parseT3ProjectFile(`{
        "scripts": [{
          "name": "File device", "command": "checkout-device",
          "resource": { "color": "#3b82f6", "checkoutPrompt": "", "releaseCommand": "release-device", "releasePrompt": "" }
        }]
      }`);
      const action = resolveInheritedProjectScripts([], file?.scripts ?? [], [], [])[0]!;
      yield* h.reactor.start();
      yield* h.request("checkout", owner, action);
      expect((yield* Queue.take(h.scripts)).args).toEqual(["-lc", "checkout-device"]);
      yield* Queue.take(h.completions);
      yield* h.reactor.drain;
      expect(h.locks()[0]).toMatchObject({
        threadId: owner,
        phase: "held",
        script: { id: "file:file device" },
      });
      yield* h.request("release", owner, action);
      expect((yield* Queue.take(h.scripts)).args).toEqual(["-lc", "release-device"]);
      yield* Queue.take(h.completions);
      yield* h.reactor.drain;
      expect(h.locks()).toEqual([]);
      expect(h.logs()).toHaveLength(2);
      expect(h.logs()[0]).toMatchObject({
        action: "release",
        status: "succeeded",
        command: "release-device",
        stdout: "script output",
      });
      expect(h.logs()[1]).toMatchObject({
        action: "checkout",
        status: "succeeded",
        stdout: "script output",
      });
    }),
  );

  it.effect(
    "holds exclusive ownership, preserves cleanup after edits, and rejects stale completions",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.request("checkout");
        expect(h.locks()[0]?.phase).toBe("checkout");
        expect((yield* Effect.flip(h.request("checkout", other))).message).toContain(
          "held by thread",
        );
        const operationId = h.locks()[0]!.operationId;
        yield* h.dispatch({
          type: "project.resource.complete",
          commandId: h.nextId(),
          projectId,
          operationId,
        });
        expect(h.locks()[0]?.phase).toBe("held");
        yield* h.request("release", owner, {
          ...script,
          resource: { ...script.resource!, releaseCommand: "different-cleanup" },
        });
        expect(h.locks()[0]?.script.resource?.releaseCommand).toBe("release-device");
        yield* h.dispatch({
          type: "project.resource.complete",
          commandId: h.nextId(),
          projectId,
          operationId,
        });
        expect(h.locks()[0]?.phase).toBe("release");
        yield* h.dispatch({
          type: "project.resource.complete",
          commandId: h.nextId(),
          projectId,
          operationId: h.locks()[0]!.operationId,
        });
        expect(h.locks()).toEqual([]);
        yield* h.request("checkout", other);
        expect(h.locks()[0]?.threadId).toBe(other);
      }),
  );

  it.effect("takes over atomically and rejects stale confirmations and running hooks", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.request("checkout");
      const original = h.locks()[0]!;
      expect(
        (yield* Effect.flip(h.request("takeover", other, script, original.operationId))).message,
      ).toContain("hooks are still running");
      yield* h.dispatch({
        type: "project.resource.complete",
        commandId: h.nextId(),
        projectId,
        operationId: original.operationId,
      });
      expect((yield* Effect.flip(h.request("takeover", other))).message).toContain(
        "ownership changed",
      );
      yield* h.request("takeover", other, script, original.operationId);
      expect(h.locks()).toHaveLength(1);
      expect(h.locks()[0]).toMatchObject({ threadId: other, phase: "checkout", script });
      const takeover = h.locks()[0]!;
      yield* h.dispatch({
        type: "project.resource.complete",
        commandId: h.nextId(),
        projectId,
        operationId: original.operationId,
        error: "stale failure",
      });
      expect(h.locks()[0]).toEqual(takeover);
      yield* h.dispatch({
        type: "project.resource.complete",
        commandId: h.nextId(),
        projectId,
        operationId: takeover.operationId,
      });
      expect(
        (yield* Effect.flip(h.request("takeover", owner, script, original.operationId))).message,
      ).toContain("ownership changed");
      expect((yield* Effect.flip(h.request("release", owner))).message).toContain("held by thread");
      yield* h.request("release", other);
      expect(h.locks()[0]).toMatchObject({ threadId: other, phase: "release" });
    }),
  );

  it.effect(
    "runs each script before its prompt and releases only after the release turn finishes",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.reactor.start();
        yield* h.request("checkout");
        expect((yield* Queue.take(h.scripts)).args).toEqual(["-lc", "checkout-device"]);
        const prompt = yield* Queue.take(h.prompts);
        expect(prompt).toMatchObject({
          type: "thread.turn.start",
          message: { text: "Prepare the device" },
        });
        expect(h.locks()[0]?.phase).toBe("checkout");
        yield* h.session("running");
        yield* h.session("ready");
        yield* Queue.take(h.completions);
        expect(h.locks()[0]?.phase).toBe("held");
        yield* h.request("release");
        expect((yield* Queue.take(h.scripts)).args).toEqual(["-lc", "release-device"]);
        expect(yield* Queue.take(h.prompts)).toMatchObject({
          message: { text: "Clean up the device" },
        });
        expect(h.locks()[0]?.phase).toBe("release");
        yield* h.session("running");
        yield* h.session("ready");
        yield* Queue.take(h.completions);
        yield* h.reactor.drain;
        expect(h.locks()).toEqual([]);
      }),
  );

  it.effect("retains failed locks, blocks removal, and supports force release", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.reactor.start();
      h.failScript();
      yield* h.request("checkout");
      yield* Queue.take(h.completions);
      expect(h.locks()[0]).toMatchObject({
        phase: "failed",
        error: expect.stringContaining("cleanup failed"),
      });
      expect(
        (yield* Effect.flip(
          h.dispatch({ type: "thread.delete", commandId: h.nextId(), threadId: owner }),
        )).message,
      ).toContain("Release");
      yield* h.request("force-release");
      expect(h.locks()).toEqual([]);
      expect(h.logs()[0]).toMatchObject({
        status: "failed",
        stdout: "script output",
        stderr: "cleanup failed",
        error: expect.stringContaining("cleanup failed"),
      });
    }),
  );

  it.effect("retains an interrupted operation on restart without rerunning hooks", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.request("checkout");
      yield* h.reactor.start();
      expect(h.locks()[0]).toMatchObject({
        phase: "failed",
        error: expect.stringContaining("restarted"),
      });
      expect(h.logs()[0]).toMatchObject({
        status: "failed",
        error: expect.stringContaining("restarted"),
      });
    }),
  );
});
