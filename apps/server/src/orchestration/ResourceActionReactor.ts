import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import {
  EventId,
  type ResourceActionLog,
  CommandId,
  MessageId,
  type ProjectId,
  type ProjectResourceLock,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { makeKeyedDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
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

  const abortSignals = new Map<string, Deferred.Deferred<void>>();

  const complete = (work: Work, error?: string) =>
    engine.dispatch({
      type: "project.resource.complete",
      commandId: CommandId.make(`resource-complete-${work.lock.operationId}`),
      projectId: work.projectId,
      operationId: work.lock.operationId,
      ...(error === undefined ? {} : { error }),
    });

  const recordLog = Effect.fn("ResourceActionReactor.recordLog")(function* (
    work: Work,
    log: ResourceActionLog,
    revision?: number,
  ) {
    const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(
        `resource-log-${log.operationId}-${log.status}${revision === undefined ? "" : `-${revision}`}`,
      ),
      threadId: work.lock.threadId,
      createdAt,
      activity: {
        id: EventId.make(`resource-log-${log.operationId}-${log.status}`),
        kind: "resource.action",
        tone: log.status === "failed" ? "error" : "info",
        summary: `${log.resourceName}: ${log.action} ${log.status}`,
        payload: log,
        turnId: null,
        createdAt,
      },
    });
  });

  const run = Effect.fn("ResourceActionReactor.run")(function* (
    work: Work,
    output: { stdout: string; stderr: string; truncated: boolean; promptStarted: boolean },
    notifyOutput: () => void,
  ) {
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
      const captured = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      const capture = (stream: "stdout" | "stderr") => (chunk: Uint8Array) => {
        const combined = Buffer.concat([captured[stream], chunk]);
        let start = Math.max(0, combined.length - 16_384);
        if (start > 0) {
          output.truncated = true;
          // Do not start the retained tail in the middle of a UTF-8 character.
          while (start < combined.length && (combined[start]! & 0xc0) === 0x80) start++;
        }
        captured[stream] = Buffer.from(combined.subarray(start));
        output[stream] = captured[stream].toString("utf8");
        notifyOutput();
      };
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
        timeout: Duration.infinity,
        forceKillAfter: "5 seconds",
        onStdoutChunk: capture("stdout"),
        onStderrChunk: capture("stderr"),
        maxOutputBytes: 16_384,
        outputMode: "truncate",
      });
      if (captured.stdout.length === 0) output.stdout = result.stdout;
      if (captured.stderr.length === 0) output.stderr = result.stderr;
      output.truncated ||= result.stdoutTruncated || result.stderrTruncated;
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
          output.promptStarted = true;
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
      Effect.gen(function* () {
        const output = { stdout: "", stderr: "", truncated: false, promptStarted: false };
        const abortSignal = yield* Deferred.make<void>();
        abortSignals.set(work.lock.operationId, abortSignal);
        const currentProject = yield* snapshots.getProjectShellById(work.projectId);
        const alreadyAborted =
          Option.isSome(currentProject) &&
          currentProject.value.resourceLocks?.some(
            (lock) => lock.operationId === work.lock.operationId && lock.cancelRequested,
          );
        if (alreadyAborted) yield* Deferred.succeed(abortSignal, undefined);
        const abort = Deferred.await(abortSignal).pipe(
          Effect.andThen(
            Effect.fail(
              new ResourceHookError({
                message: "Resource action aborted. The reservation is still held.",
              }),
            ),
          ),
        );
        const log: ResourceActionLog = {
          operationId: work.lock.operationId,
          resourceName: work.lock.script.name,
          action: work.lock.phase === "checkout" ? "checkout" : "release",
          status: "running",
          command:
            work.lock.phase === "checkout"
              ? work.lock.script.command
              : (work.lock.script.resource?.releaseCommand ?? ""),
          ...output,
        };
        yield* recordLog(work, log);
        // Reuse the activity ID so clients retain one running log, with batched snapshots.
        // Scope the publisher to the hook so no running update can follow its final result.
        const execution = Effect.scoped(
          Effect.gen(function* () {
            const changes = yield* Queue.sliding<void>(1);
            let revision = 0;
            let published = log;
            yield* Effect.gen(function* () {
              while (true) {
                yield* Queue.take(changes);
                yield* Effect.sleep("1 second");
                const current = { ...log, ...output };
                if (
                  current.stdout === published.stdout &&
                  current.stderr === published.stderr &&
                  current.truncated === published.truncated
                )
                  continue;
                yield* recordLog(work, current, ++revision);
                published = current;
              }
            }).pipe(Effect.forkScoped);
            yield* Effect.raceFirst(
              alreadyAborted
                ? abort
                : run(work, output, () => {
                    Queue.offerUnsafe(changes, undefined);
                  }),
              abort,
            );
          }),
        );
        yield* execution.pipe(
          Effect.matchEffect({
            onSuccess: () =>
              recordLog(work, { ...log, ...output, status: "succeeded" }).pipe(
                Effect.andThen(complete(work)),
              ),
            onFailure: (error) =>
              Effect.gen(function* () {
                if (output.promptStarted) {
                  const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
                  yield* engine
                    .dispatch({
                      type: "thread.turn.interrupt",
                      commandId: CommandId.make(`resource-interrupt-${work.lock.operationId}`),
                      threadId: work.lock.threadId,
                      createdAt,
                    })
                    .pipe(Effect.ignore);
                }
                yield* recordLog(work, {
                  ...log,
                  ...output,
                  status: "failed",
                  error: error.message,
                });
                yield* complete(work, error.message);
              }),
          }),
          Effect.ensuring(Effect.sync(() => abortSignals.delete(work.lock.operationId))),
        );
      }).pipe(
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
          yield* recordLog(
            { projectId: project.id, lock },
            {
              operationId: lock.operationId,
              resourceName: lock.script.name,
              action: lock.phase,
              status: "failed",
              command:
                lock.phase === "checkout"
                  ? lock.script.command
                  : (lock.script.resource?.releaseCommand ?? ""),
              stdout: "",
              stderr: "",
              truncated: false,
              error: "Server restarted during resource hooks. Output was not captured.",
            },
          ).pipe(Effect.orDie);
          yield* complete(
            { projectId: project.id, lock },
            "Server restarted during resource hooks. Retry or release the resource.",
          ).pipe(Effect.orDie);
        }
      }
    }
    yield* events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.type !== "project.meta-updated" || !event.payload.resourceLocks) return;
          for (const entry of event.payload.resourceLocks) {
            if (
              entry.cancelRequested &&
              (entry.phase === "checkout" || entry.phase === "release")
            ) {
              const signal = abortSignals.get(entry.operationId);
              if (signal) yield* Deferred.succeed(signal, undefined);
            }
          }
          const lock = event.payload.resourceLocks.find(
            (entry) =>
              entry.operationId === event.commandId &&
              (entry.phase === "checkout" || entry.phase === "release"),
          );
          if (lock)
            yield* worker.enqueue({ projectId: event.payload.projectId, lock }).pipe(Effect.ignore);
        }),
      ),
      Effect.forkScoped,
    );
  });
  return { start, drain: worker.drain };
});

export const layer = Layer.effect(ResourceActionReactor, make);
