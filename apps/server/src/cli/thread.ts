import * as Crypto from "effect/Crypto";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EnvironmentHttpApi,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ConversationMessage,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import {
  dispatchBootstrapRpc,
  withEnvironmentRpc,
} from "../orchestration-v2/bootstrapRpcClient.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { encodeCliJson, makeEnvironmentHttpClient, withLocalEnvironment } from "./environment.ts";

const makeHttpClient = (origin: string) =>
  HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });

class ThreadCliError extends Schema.TaggedError<ThreadCliError>()("ThreadCliError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const ThreadStartOutput = Schema.fromJsonString(
  Schema.Struct({
    threadId: ThreadId,
    projectId: ProjectId,
    branch: Schema.String,
    cwd: Schema.String,
  }),
);
const encodeThreadStartOutput = Schema.encodeEffect(ThreadStartOutput);

export function buildIsolatedThreadStart(input: {
  readonly project: { readonly id: ProjectId; readonly workspaceRoot: string };
  readonly title: string;
  readonly message: string;
  readonly modelSelection: ModelSelection;
  readonly baseBranch: string;
  readonly branch: string;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly commandId: CommandId;
}): OrchestrationV2ThreadLaunchInput {
  return {
    commandId: input.commandId,
    creationSource: "server",
    threadId: input.threadId,
    projectId: input.project.id,
    title: input.title,
    modelSelection: input.modelSelection,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    workspaceStrategy: { type: "worktree", baseRef: input.baseBranch, branch: input.branch },
    initialMessage: { messageId: input.messageId, text: input.message, attachments: [] },
  };
}

const startThread = Command.make("start", {
  ...projectLocationFlags,
  project: Argument.String("project").pipe(
    Argument.withDescription("Project id, title, or workspace root."),
  ),
  title: Flag.String("title").pipe(Flag.withDescription("Thread title.")),
  messageFile: Flag.String("message-file").pipe(
    Flag.withDescription("File containing the first user message."),
  ),
  baseBranch: Flag.String("base-branch").pipe(
    Flag.withDescription("Existing branch to base the isolated worktree on."),
  ),
  branch: Flag.String("branch").pipe(
    Flag.withDescription("New worktree branch; defaults to a generated name."),
    Flag.optional,
  ),
  instance: Flag.String("instance").pipe(
    Flag.withDescription("Provider instance id; defaults to the project model selection."),
    Flag.optional,
  ),
  model: Flag.String("model").pipe(
    Flag.withDescription("Model id; defaults to the project model selection."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Start a thread after creating an isolated worktree on the running server.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      const runtime = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
      if (Option.isNone(runtime)) {
        return yield* new ThreadCliError({ detail: "A running T3 Code server is required." });
      }
      const origin = runtime.value.origin;
      return yield* Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const fs = yield* FileSystem.FileSystem;
        const message = (yield* fs.readFileString(flags.messageFile)).trim();
        if (!message) return yield* new ThreadCliError({ detail: "The message file is empty." });
        const title = flags.title.trim();
        const baseBranch = flags.baseBranch.trim();
        if (!title || !baseBranch) {
          return yield* new ThreadCliError({ detail: "Title and base branch must be nonempty." });
        }

        return yield* Effect.acquireUseRelease(
          auth.issueSession({
            scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
            label: "t3 thread cli",
          }),
          (issued) =>
            Effect.gen(function* () {
              const client = yield* makeHttpClient(origin);
              const headers = {
                authorization: `Bearer ${issued.token}`,
                "x-t3-orchestration-protocol": "2" as const,
              };
              const snapshot = yield* client.orchestration.shellSnapshot({ headers });
              const matches = snapshot.projects.filter(
                (project) =>
                  project.id === flags.project ||
                  project.title === flags.project ||
                  project.workspaceRoot === flags.project,
              );
              if (matches.length !== 1) {
                return yield* new ThreadCliError({
                  detail: `Expected one active project matching '${flags.project}'; found ${matches.length}.`,
                });
              }
              const project = matches[0]!;
              const instanceId =
                Option.getOrUndefined(flags.instance) ?? project.defaultModelSelection?.instanceId;
              const model =
                Option.getOrUndefined(flags.model) ?? project.defaultModelSelection?.model;
              if (!instanceId || !model) {
                return yield* new ThreadCliError({
                  detail:
                    "Pass --instance and --model, or configure a default model on the project.",
                });
              }
              const modelSelection: ModelSelection =
                project.defaultModelSelection?.instanceId === instanceId &&
                project.defaultModelSelection.model === model
                  ? project.defaultModelSelection
                  : { instanceId: ProviderInstanceId.make(instanceId), model };
              const threadId = ThreadId.make(
                yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie),
              );
              const branchSuffix = Array.from(
                yield* (yield* Crypto.Crypto).randomBytes(4).pipe(Effect.orDie),
                (byte) => byte.toString(16).padStart(2, "0"),
              ).join("");
              const branch =
                Option.getOrUndefined(flags.branch) ??
                buildTemporaryWorktreeBranchName(() => branchSuffix);
              const command = buildIsolatedThreadStart({
                project,
                title,
                message,
                modelSelection,
                baseBranch,
                branch,
                threadId,
                messageId: MessageId.make(
                  yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie),
                ),
                commandId: CommandId.make(
                  yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie),
                ),
              });
              const { thread: created } = yield* dispatchBootstrapRpc({
                origin,
                sessionId: issued.sessionId,
                command,
                waitForThread: threadId,
              });
              if (!created?.worktreePath) {
                return yield* new ThreadCliError({
                  detail: `Thread ${threadId} started, but its worktree path could not be verified.`,
                });
              }
              const output = yield* encodeThreadStartOutput({
                threadId,
                projectId: project.id,
                branch: created.branch ?? "",
                cwd: created.worktreePath,
              });
              yield* Console.log(output);
            }),
          (issued) => auth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
        );
      }).pipe(
        Effect.provide(
          EnvironmentAuth.layerRuntime.pipe(
            Layer.provideMerge(FetchHttpClient.layer),
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
          ),
        ),
      );
    }),
  ),
);

const searchThreads = Command.make("search", {
  ...projectLocationFlags,
  query: Argument.String("query"),
  limit: Flag.Int("limit").pipe(Flag.optional),
}).pipe(
  Command.withDescription("Search user and assistant messages."),
  Command.withHandler((flags) =>
    withLocalEnvironment(flags, ({ origin, sessionId }) =>
      withEnvironmentRpc({ origin, sessionId }, (rpc) =>
        Effect.gen(function* () {
          const result = yield* rpc[ORCHESTRATION_V2_WS_METHODS.searchThreads]({
            query: flags.query,
            ...(Option.isSome(flags.limit) ? { limit: flags.limit.value } : {}),
          });
          yield* Console.log(yield* encodeCliJson(result));
        }),
      ),
    ),
  ),
);

const sendMessage = Command.make("send", {
  ...projectLocationFlags,
  threadId: Argument.String("thread-id"),
  messageFile: Flag.String("message-file"),
}).pipe(
  Command.withDescription("Send a user message and start the next turn."),
  Command.withHandler((flags) =>
    withLocalEnvironment(flags, ({ origin, token, sessionId }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const text = (yield* fs.readFileString(flags.messageFile)).trim();
        if (!text) return yield* new ThreadCliError({ detail: "The message file is empty." });
        const client = yield* makeEnvironmentHttpClient(origin);
        const snapshot = yield* client.orchestration.shellSnapshot({
          headers: { authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": "2" },
        });
        const thread = snapshot.threads.find((item) => item.id === flags.threadId);
        if (!thread) {
          return yield* new ThreadCliError({ detail: `Thread ${flags.threadId} was not found.` });
        }
        const command = {
          type: "message.dispatch" as const,
          createdBy: "user" as const,
          creationSource: "server" as const,
          commandId: CommandId.make(yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)),
          threadId: thread.id,
          messageId: MessageId.make(yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)),
          text,
          attachments: [],
          modelSelection: thread.modelSelection,
          dispatchMode: { type: "start_immediately" as const },
          deliveryIntent: "auto" as const,
        };
        const result = yield* withEnvironmentRpc({ origin, sessionId }, (rpc) =>
          rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command),
        );
        yield* Console.log(yield* encodeCliJson(result));
      }),
    ),
  ),
);

/** A turn can contain several assistant messages, so page at user-message boundaries. */
export const recentThreadMessages = <
  Message extends Pick<OrchestrationV2ConversationMessage, "role">,
>(
  messages: ReadonlyArray<Message>,
  turns: number,
) => {
  let remaining = turns;
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role === "user" && --remaining === 0) {
      start = index;
      break;
    }
  }
  return { messages: messages.slice(start), hasMore: start > 0 };
};

export const isFinishedThread = (
  thread: Pick<OrchestrationV2ThreadShell, "latestRunId" | "status">,
) =>
  thread.latestRunId !== null &&
  ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(thread.status);

const listMessages = Command.make("messages", {
  ...projectLocationFlags,
  threadId: Argument.String("thread-id"),
  turns: Flag.Int("turns").pipe(Flag.optional),
}).pipe(
  Command.withDescription("Read a thread's recent messages."),
  Command.withHandler((flags) =>
    withLocalEnvironment(flags, ({ origin, sessionId }) =>
      withEnvironmentRpc({ origin, sessionId }, (rpc) =>
        Effect.gen(function* () {
          const turns = Option.getOrUndefined(flags.turns) ?? 10;
          if (turns < 1) return yield* new ThreadCliError({ detail: "Turns must be positive." });
          const item = yield* rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
            threadId: ThreadId.make(flags.threadId),
          }).pipe(
            Stream.filterMap((item) =>
              item.kind === "snapshot" ? Result.succeed(item) : Result.failVoid,
            ),
            Stream.runHead,
            Effect.timeout("15 seconds"),
          );
          if (Option.isNone(item)) {
            return yield* new ThreadCliError({ detail: "No thread snapshot was received." });
          }
          const page = recentThreadMessages(item.value.projection.messages, turns);
          yield* Console.log(
            yield* encodeCliJson({
              threadId: item.value.projection.thread.id,
              messages: page.messages.map((message) => ({
                id: message.id,
                role: message.role,
                text: message.text,
                streaming: message.streaming,
                createdAt: DateTime.formatIso(message.createdAt),
              })),
              hasMore: page.hasMore,
            }),
          );
        }),
      ),
    ),
  ),
);

const threadSummary = (thread: OrchestrationV2ThreadShell) => ({
  threadId: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  branch: thread.branch,
  cwd: thread.worktreePath,
  latestTurn: thread.latestRunId ? { turnId: thread.latestRunId, state: thread.status } : null,
  status: thread.status,
  updatedAt: DateTime.formatIso(thread.updatedAt),
});

const listThreads = Command.make("list", {
  ...projectLocationFlags,
  limit: Flag.Int("limit").pipe(Flag.optional),
}).pipe(
  Command.withDescription("List recently updated threads."),
  Command.withHandler((flags) =>
    withLocalEnvironment(flags, ({ origin, token }) =>
      Effect.gen(function* () {
        const limit = Option.getOrUndefined(flags.limit) ?? 20;
        if (limit < 1) return yield* new ThreadCliError({ detail: "Limit must be positive." });
        const client = yield* makeEnvironmentHttpClient(origin);
        const snapshot = yield* client.orchestration.shellSnapshot({
          headers: { authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": "2" },
        });
        const threads = snapshot.threads
          .filter((thread) => thread.deletedAt === null)
          .toSorted(
            (a, b) => DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt),
          )
          .slice(0, limit)
          .map(threadSummary);
        yield* Console.log(yield* encodeCliJson({ threads }));
      }),
    ),
  ),
);

const threadStatus = Command.make("status", {
  ...projectLocationFlags,
  threadId: Argument.String("thread-id"),
}).pipe(
  Command.withDescription("Show a thread's worktree and latest turn state."),
  Command.withHandler((flags) =>
    withLocalEnvironment(flags, ({ origin, token }) =>
      Effect.gen(function* () {
        const client = yield* makeEnvironmentHttpClient(origin);
        const snapshot = yield* client.orchestration.shellSnapshot({
          headers: { authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": "2" },
        });
        const thread = snapshot.threads.find(
          (entry) => entry.id === flags.threadId && entry.deletedAt === null,
        );
        if (!thread) {
          return yield* new ThreadCliError({ detail: `Thread ${flags.threadId} was not found.` });
        }
        yield* Console.log(yield* encodeCliJson(threadSummary(thread)));
      }),
    ),
  ),
);

const waitForThread = Command.make("wait", {
  ...projectLocationFlags,
  threadId: Argument.String("thread-id"),
  afterSequence: Flag.Int("after-sequence").pipe(Flag.optional),
  timeoutSeconds: Flag.Int("timeout-seconds").pipe(Flag.optional),
}).pipe(
  Command.withDescription("Wait for the latest turn to finish."),
  Command.withHandler((flags) =>
    withLocalEnvironment(flags, ({ origin, sessionId }) =>
      withEnvironmentRpc({ origin, sessionId }, (rpc) =>
        Effect.gen(function* () {
          const timeoutSeconds = Option.getOrUndefined(flags.timeoutSeconds) ?? 300;
          if (timeoutSeconds < 1) {
            return yield* new ThreadCliError({ detail: "Timeout must be positive." });
          }
          const afterSequence = Option.getOrUndefined(flags.afterSequence) ?? 0;
          const thread = yield* rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
            Stream.filterMap((item) => {
              const entry =
                item.kind === "snapshot"
                  ? item.snapshot.snapshotSequence >= afterSequence
                    ? item.snapshot.threads.find((thread) => thread.id === flags.threadId)
                    : undefined
                  : item.kind === "thread.updated" &&
                      item.sequence >= afterSequence &&
                      item.thread.id === flags.threadId
                    ? item.thread
                    : undefined;
              return entry && isFinishedThread(entry) ? Result.succeed(entry) : Result.failVoid;
            }),
            Stream.runHead,
            Effect.timeout(`${timeoutSeconds} seconds`),
            Effect.catchTags({
              TimeoutError: () =>
                new ThreadCliError({
                  detail: `Timed out waiting for thread ${flags.threadId} after ${timeoutSeconds} seconds.`,
                }),
            }),
          );
          if (Option.isNone(thread)) {
            return yield* new ThreadCliError({ detail: "The thread subscription ended." });
          }
          yield* Console.log(yield* encodeCliJson(threadSummary(thread.value)));
        }),
      ),
    ),
  ),
);

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Manage threads on a running T3 Code server."),
  Command.withSubcommands([
    startThread,
    searchThreads,
    sendMessage,
    listMessages,
    listThreads,
    threadStatus,
    waitForThread,
  ]),
);
