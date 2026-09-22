import { CommandId, MessageId, type ProjectId, type ProjectResourceLock } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { makeKeyedDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ProcessRunner } from "../processRunner.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

class ResourceHookError extends Schema.TaggedError<ResourceHookError>()("ResourceHookError", {
  message: Schema.String,
}) {}

export class ResourceActionReactor extends Context.Service<
  ResourceActionReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ResourceActionReactor") {}

type Work = { readonly projectId: ProjectId; readonly lock: ProjectResourceLock };

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const runner = yield* ProcessRunner;
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;

  const complete = (work: Work, error?: string) =>
    engine.dispatch({
      type: "project.resource.complete",
      commandId: CommandId.make(`resource-complete-${work.lock.operationId}`),
      projectId: work.projectId,
      operationId: work.lock.operationId,
      ...(error === undefined ? {} : { error }),
    });

  const run = Effect.fn("ResourceActionReactor.run")(function* (work: Work) {
    const { lock } = work;
    const project = yield* snapshots.getProjectShellById(work.projectId);
    const thread = yield* snapshots.getThreadShellById(lock.threadId);
    if (Option.isNone(project) || Option.isNone(thread)) {
      return yield* new ResourceHookError({ message: "Resource owner is unavailable." });
    }
    const resource = lock.script.resource;
    if (!resource) return yield* new ResourceHookError({ message: "Resource hooks are missing." });
    const command = lock.phase === "checkout" ? lock.script.command : resource.releaseCommand;
    const prompt = lock.phase === "checkout" ? resource.checkoutPrompt : resource.releasePrompt;
    if (command.trim()) {
      const result = yield* runner.run({
        command: platform === "win32" ? "powershell.exe" : env.SHELL || "/bin/sh",
        args: platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command],
        cwd: thread.value.worktreePath ?? project.value.workspaceRoot,
        env: {
          ...env,
          T3CODE_PROJECT_ROOT: project.value.workspaceRoot,
          T3CODE_THREAD_ID: lock.threadId,
          T3CODE_RESOURCE_ID: lock.script.id,
          ...(thread.value.worktreePath ? { T3CODE_WORKTREE_PATH: thread.value.worktreePath } : {}),
        },
        maxOutputBytes: 16_384,
        outputMode: "truncate",
      });
      if (result.code !== 0)
        return yield* new ResourceHookError({
          message: `Resource script exited with ${result.code}: ${result.stderr || result.stdout}`,
        });
    }
    if (prompt.trim()) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          // Subscribe before dispatch: even a very short provider turn must be observed.
          const events = yield* engine.subscribeDomainEvents;
          const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
          yield* engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`resource-prompt-${lock.operationId}`),
            threadId: lock.threadId,
            message: {
              messageId: MessageId.make(`resource-${lock.operationId}`),
              role: "user",
              text: prompt,
              attachments: [],
            },
            modelSelection: thread.value.modelSelection,
            runtimeMode: thread.value.runtimeMode,
            interactionMode: thread.value.interactionMode,
            createdAt,
          });
          let running = false;
          const outcome = yield* events.pipe(
            Stream.filter((event) => {
              if (
                event.type === "thread.activity-appended" &&
                event.payload.threadId === lock.threadId &&
                event.payload.activity.kind === "provider.turn.start.failed"
              )
                return true;
              if (event.type !== "thread.session-set" || event.payload.threadId !== lock.threadId)
                return false;
              const status = event.payload.session.status;
              if (status === "running") running = true;
              return (
                status === "error" ||
                status === "stopped" ||
                status === "interrupted" ||
                (running && status === "ready")
              );
            }),
            Stream.take(1),
            Stream.runHead,
          );
          if (
            Option.isNone(outcome) ||
            outcome.value.type !== "thread.session-set" ||
            outcome.value.payload.session.status !== "ready"
          ) {
            return yield* new ResourceHookError({
              message:
                "Resource prompt did not finish successfully. Retry or release the resource.",
            });
          }
        }),
      );
    }
  });

  const worker = yield* makeKeyedDrainableWorker({
    concurrency: 16,
    key: (work: Work) => work.lock.threadId,
    process: (work: Work) =>
      run(work).pipe(
        Effect.matchEffect({
          onSuccess: () => complete(work),
          onFailure: (error) => complete(work, error.message),
        }),
        Effect.catchCause((cause) =>
          Effect.logError("Resource action failed", Cause.pretty(cause)),
        ),
        Effect.asVoid,
      ),
  });

  const start = Effect.fn("ResourceActionReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    // Never rerun a hook with external side effects automatically after a restart.
    const snapshot = yield* snapshots.getShellSnapshot().pipe(Effect.orDie);
    for (const project of snapshot.projects) {
      for (const lock of project.resourceLocks ?? []) {
        if (lock.phase === "checkout" || lock.phase === "release") {
          yield* complete(
            { projectId: project.id, lock },
            "Server restarted during resource hooks. Retry or release the resource.",
          ).pipe(Effect.orDie);
        }
      }
    }
    yield* events.pipe(
      Stream.runForEach((event) => {
        if (event.type !== "project.meta-updated" || !event.payload.resourceLocks)
          return Effect.void;
        const lock = event.payload.resourceLocks.find(
          (entry) =>
            entry.operationId === event.commandId &&
            (entry.phase === "checkout" || entry.phase === "release"),
        );
        return lock
          ? worker.enqueue({ projectId: event.payload.projectId, lock }).pipe(Effect.ignore)
          : Effect.void;
      }),
      Effect.forkScoped,
    );
  });
  return { start, drain: worker.drain };
});

export const layer = Layer.effect(ResourceActionReactor, make);
