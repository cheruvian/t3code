import {
  CommandId,
  EnvironmentId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type ThreadMoveImportReceipt,
  type ThreadMoveCancellationReceipt,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadManagement from "./ThreadManagementService.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export class ThreadMoveError extends Schema.TaggedError<ThreadMoveError>()("ThreadMoveError", {
  operation: Schema.Literals(["fence", "activate", "abort", "finalize", "status"]),
  threadId: ThreadId,
  reason: Schema.Literals([
    "active-terminal",
    "unsupported-provider",
    "unresolved-lineage",
    "missing-native-thread",
    "dispatch-failed",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported-provider":
        return "Only Codex and Claude threads can move between environments.";
      case "unresolved-lineage":
        return "Threads with subagent children or unresolved cross-thread lineage cannot be moved.";
      case "missing-native-thread":
        return "The thread does not have a strong provider-native session to move.";
      case "active-terminal":
        return "Close the thread's terminals before moving it.";
      case "dispatch-failed":
        return `Thread move ${this.operation} failed for ${this.threadId}.`;
    }
  }
}
const isThreadMoveError = Schema.is(ThreadMoveError);

export interface ThreadMoveFenceInput {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly moveId: string;
  readonly destinationEnvironmentId: EnvironmentId;
}

export interface ThreadMoveFinalizeInput {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly moveId: string;
  readonly receipt: ThreadMoveImportReceipt;
}

export interface ThreadMoveAbortInput {
  readonly cancellation?: ThreadMoveCancellationReceipt;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly moveId: string;
}

export interface ThreadMoveStatusInput {
  readonly threadId: ThreadId;
}

export interface ThreadMoveStatus {
  readonly state: "idle" | "fenced" | "activating" | "moved";
  readonly moveId: string | null;
  readonly destinationEnvironmentId: EnvironmentId | null;
}

export class ThreadMoveService extends Context.Service<
  ThreadMoveService,
  {
    readonly fence: (
      input: ThreadMoveFenceInput,
    ) => Effect.Effect<{ readonly providerDriver: "codex" | "claudeAgent" }, ThreadMoveError>;
    readonly reclaim: (
      input: ThreadMoveAbortInput & { readonly cancellation: ThreadMoveCancellationReceipt },
    ) => Effect.Effect<void, ThreadMoveError>;
    readonly abort: (input: ThreadMoveAbortInput) => Effect.Effect<void, ThreadMoveError>;
    readonly prepareActivation: (
      input: ThreadMoveAbortInput,
    ) => Effect.Effect<void, ThreadMoveError>;
    readonly finalize: (input: ThreadMoveFinalizeInput) => Effect.Effect<void, ThreadMoveError>;
    readonly status: (
      input: ThreadMoveStatusInput,
    ) => Effect.Effect<ThreadMoveStatus, ThreadMoveError>;
  }
>()("t3/orchestration-v2/ThreadMoveService") {}

function portableDriver(
  providerThread: OrchestrationV2ProviderThread | undefined,
): "codex" | "claudeAgent" | null {
  if (providerThread?.driver === "codex") return "codex";
  if (providerThread?.driver === "claudeAgent") return "claudeAgent";
  return null;
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const terminals = yield* TerminalManager.TerminalManager;

  const load = (threadId: ThreadId, operation: ThreadMoveError["operation"]) =>
    threads.getThreadRecords(threadId, ["providerThreads", "subagents", "contextTransfers"]).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadMoveError({
            operation,
            threadId,
            reason: "dispatch-failed",
            cause,
          }),
      ),
    );

  const dispatch = (
    operation: ThreadMoveError["operation"],
    threadId: ThreadId,
    command: Parameters<ThreadManagement.ThreadManagementService["Service"]["dispatch"]>[0],
  ) =>
    threads.dispatch(command).pipe(
      Effect.asVoid,
      Effect.mapError(
        (cause) => new ThreadMoveError({ operation, threadId, reason: "dispatch-failed", cause }),
      ),
    );

  const fence: ThreadMoveService["Service"]["fence"] = Effect.fn("ThreadMoveService.fence")(
    function* (input) {
      const projection = yield* load(input.threadId, "fence");
      if (
        projection.subagents.length > 0 ||
        projection.contextTransfers.some((transfer) =>
          ["pending", "resolved_native", "resolved_portable"].includes(transfer.status),
        )
      ) {
        return yield* new ThreadMoveError({
          operation: "fence",
          threadId: input.threadId,
          reason: "unresolved-lineage",
        });
      }
      const providerThread =
        projection.providerThreads.find(
          (candidate) => candidate.id === projection.thread.activeProviderThreadId,
        ) ?? projection.providerThreads.at(-1);
      const driver = portableDriver(providerThread);
      if (driver === null) {
        return yield* new ThreadMoveError({
          operation: "fence",
          threadId: input.threadId,
          reason: "unsupported-provider",
        });
      }
      if (
        providerThread?.nativeThreadRef === null ||
        providerThread?.nativeThreadRef === undefined ||
        providerThread.nativeThreadRef.strength !== "strong" ||
        providerThread.nativeThreadRef.nativeId === null
      ) {
        return yield* new ThreadMoveError({
          operation: "fence",
          threadId: input.threadId,
          reason: "missing-native-thread",
        });
      }
      const command = { type: "thread.move.fence" as const, ...input };
      yield* threads
        .dispatchWithPrecondition(
          command,
          terminals.hasOpenForThread(input.threadId).pipe(
            Effect.flatMap((hasOpenTerminal) =>
              hasOpenTerminal
                ? Effect.fail(
                    new ThreadMoveError({
                      operation: "fence",
                      threadId: input.threadId,
                      reason: "active-terminal",
                    }),
                  )
                : Effect.void,
            ),
          ),
        )
        .pipe(
          Effect.asVoid,
          Effect.mapError((cause) =>
            isThreadMoveError(cause)
              ? cause
              : new ThreadMoveError({
                  operation: "fence",
                  threadId: input.threadId,
                  reason: "dispatch-failed",
                  cause,
                }),
          ),
        );
      return { providerDriver: driver };
    },
  );

  return ThreadMoveService.of({
    fence,
    reclaim: (input) =>
      dispatch("abort", input.threadId, { type: "thread.move.reclaim", ...input }),
    abort: (input) => dispatch("abort", input.threadId, { type: "thread.move.abort", ...input }),
    prepareActivation: (input) =>
      dispatch("activate", input.threadId, { type: "thread.move.activate", ...input }),
    finalize: (input) =>
      dispatch("finalize", input.threadId, { type: "thread.move.finalize", ...input }),
    status: (input) =>
      load(input.threadId, "status").pipe(
        Effect.map(({ thread }) => ({
          state: thread.environmentMove?.status ?? "idle",
          moveId: thread.environmentMove?.moveId ?? null,
          destinationEnvironmentId: thread.environmentMove?.destinationEnvironmentId ?? null,
        })),
      ),
  });
});

export const layer = Layer.effect(ThreadMoveService, make);
