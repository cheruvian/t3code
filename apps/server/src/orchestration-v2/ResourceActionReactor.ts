import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import {
  EventId,
  type ResourceActionLog,
  CommandId,
  MessageId,
  TurnItemId,
  type RunId,
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
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";

class ResourceHookError extends Schema.TaggedError<ResourceHookError>()("ResourceHookError", {
  message: Schema.String,
}) {}

export class ResourceActionReactor extends Context.Service<
  ResourceActionReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ResourceActionReactor") {}

type Work = { readonly projectId: ProjectId; readonly lock: ProjectResourceLock };

export const make = Effect.gen(function* () {
  const engine = yield* OrchestratorV2;
  const snapshots = yield* ProjectionStoreV2;
  const projects = yield* ProjectService;
  const eventSink = yield* EventSinkV2;
  const projectEvents = yield* OrchestrationEventStore;
  const runner = yield* ProcessRunner;
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;

  const abortSignals = new Map<string, Deferred.Deferred<void>>();

  const complete = (work: Work, error?: string) =>
    projects
      .resourceComplete({
        commandId: CommandId.make(`resource-complete-${work.lock.operationId}`),
        projectId: work.projectId,
        operationId: work.lock.operationId,
        ...(error === undefined ? {} : { error }),
      })
      .pipe(Effect.tap(() => engine.resumeQueuedRuns));

  const recordLog = Effect.fn("ResourceActionReactor.recordLog")(function* (
    work: Work,
    log: ResourceActionLog,
    revision?: number,
  ) {
    const now = yield* DateTime.now;
    yield* eventSink.write({
      commandId: CommandId.make(`resource-log-${log.operationId}-${log.status}-${revision ?? 0}`),
      events: [
        {
          id: EventId.make(`resource-log-${log.operationId}-${log.status}-${revision ?? 0}`),
          type: "turn-item.updated",
          threadId: work.lock.threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`resource-log-${log.operationId}`),
            type: "command_execution",
            threadId: work.lock.threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: log.status === "succeeded" ? "completed" : log.status,
            title: `${log.resourceName}: ${log.action}`,
            startedAt: null,
            completedAt: log.status === "running" ? null : now,
            updatedAt: now,
            input: log.command,
            output: [log.stdout, log.stderr, log.error].filter(Boolean).join("\n"),
            outputIndicatesFailure: log.status === "failed",
            resourceActionLog: log,
          },
        },
      ],
    });
  });

  const run = Effect.fn("ResourceActionReactor.run")(function* (
    work: Work,
    output: { stdout: string; stderr: string; truncated: boolean; promptRunId?: RunId },
    notifyOutput: () => void,
  ) {
    const { lock } = work;
    const project = yield* projects.getShell(work.projectId);
    const thread = yield* snapshots.getThreadShell(lock.threadId);
    if (Option.isNone(project) || thread === null) {
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
        cwd: thread.worktreePath ?? project.value.workspaceRoot,
        env: {
          ...env,
          T3CODE_PROJECT_ROOT: project.value.workspaceRoot,
          T3CODE_THREAD_ID: lock.threadId,
          T3CODE_RESOURCE_ID: lock.script.id,
          ...(thread.worktreePath ? { T3CODE_WORKTREE_PATH: thread.worktreePath } : {}),
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
          // A durable cursor observes even terminal events emitted during dispatch.
          const afterSequence = yield* eventSink.latestSequence({ threadId: lock.threadId });
          yield* Effect.gen(function* () {
            const dispatched = yield* engine.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`resource-prompt-${lock.operationId}`),
              threadId: lock.threadId,
              messageId: MessageId.make(`resource-${lock.operationId}`),
              text: prompt,
              attachments: [],
              resourceOperationId: lock.operationId,
              createdBy: "system",
              creationSource: "server",
              dispatchMode: { type: "start_immediately" },
            });
            const created = dispatched.storedEvents.find(
              (stored) => stored.event.type === "run.created",
            );
            if (!created || created.event.type !== "run.created") {
              return yield* new ResourceHookError({
                message: "Resource prompt did not create a run.",
              });
            }
            output.promptRunId = created.event.payload.id;
          }).pipe(Effect.uninterruptible);
          const outcome = yield* eventSink
            .stream({ threadId: lock.threadId, afterSequence, eventType: "run.updated" })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "run.updated" &&
                  stored.event.payload.id === output.promptRunId &&
                  ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
                    stored.event.payload.status,
                  ),
              ),
              Stream.take(1),
              Stream.runHead,
            );
          if (
            Option.isNone(outcome) ||
            outcome.value.event.type !== "run.updated" ||
            outcome.value.event.payload.status !== "completed"
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
        const output: { stdout: string; stderr: string; truncated: boolean; promptRunId?: RunId } =
          { stdout: "", stderr: "", truncated: false };
        const abortSignal = yield* Deferred.make<void>();
        const currentProject = yield* projects.getShell(work.projectId);
        const currentLock = Option.isSome(currentProject)
          ? currentProject.value.resourceLocks?.find(
              (lock) => lock.operationId === work.lock.operationId,
            )
          : undefined;
        // A buffered request may already have been failed by restart recovery or released.
        if (!currentLock || (currentLock.phase !== "checkout" && currentLock.phase !== "release"))
          return;
        abortSignals.set(work.lock.operationId, abortSignal);
        const alreadyAborted = currentLock.cancelRequested === true;
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
                if (output.promptRunId) {
                  yield* engine
                    .dispatch({
                      type: "run.interrupt",
                      commandId: CommandId.make(`resource-interrupt-${work.lock.operationId}`),
                      threadId: work.lock.threadId,
                      runId: output.promptRunId,
                      holdQueue: true,
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
    const afterSequence = yield* projectEvents.latestApplicationSequence.pipe(Effect.orDie);
    const events = projectEvents.streamApplicationEvents({ afterSequence });
    // Never rerun a hook with external side effects automatically after a restart.
    const projectShells = yield* projects.listShells().pipe(Effect.orDie);
    for (const project of projectShells) {
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
          if (
            !("type" in event) ||
            event.type !== "project.meta-updated" ||
            !event.payload.resourceLocks
          )
            return;
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
