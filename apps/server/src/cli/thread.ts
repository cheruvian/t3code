import * as NodeCrypto from "node:crypto";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EnvironmentHttpApi,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  OrchestrationCommand,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type ThreadTurnStartBootstrap,
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
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { dispatchBootstrapRpc, withEnvironmentRpc } from "../orchestration/bootstrapRpcClient.ts";
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
  readonly createdAt: string;
}): Extract<OrchestrationCommand, { type: "thread.turn.start" }> {
  const bootstrap: ThreadTurnStartBootstrap = {
    createThread: {
      projectId: input.project.id,
      title: input.title,
      modelSelection: input.modelSelection,
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: input.baseBranch,
      worktreePath: null,
      createdAt: input.createdAt,
    },
    prepareWorktree: {
      projectCwd: input.project.workspaceRoot,
      baseBranch: input.baseBranch,
      branch: input.branch,
      requireWorktree: true,
    },
    runSetupScript: true,
  };
  return {
    type: "thread.turn.start",
    commandId: input.commandId,
    threadId: input.threadId,
    message: {
      messageId: input.messageId,
      role: "user",
      text: input.message,
      attachments: [],
    },
    modelSelection: input.modelSelection,
    titleSeed: input.title,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    bootstrap,
    createdAt: input.createdAt,
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
              const headers = { authorization: `Bearer ${issued.token}` };
              const snapshot = yield* client.orchestration.snapshot({ headers });
              const matches = snapshot.projects.filter(
                (project) =>
                  project.deletedAt === null &&
                  (project.id === flags.project ||
                    project.title === flags.project ||
                    project.workspaceRoot === flags.project),
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
              const threadId = ThreadId.make(NodeCrypto.randomUUID());
              const branch =
                Option.getOrUndefined(flags.branch) ??
                buildTemporaryWorktreeBranchName(() => NodeCrypto.randomBytes(4).toString("hex"));
              const command = buildIsolatedThreadStart({
                project,
                title,
                message,
                modelSelection,
                baseBranch,
                branch,
                threadId,
                messageId: MessageId.make(NodeCrypto.randomUUID()),
                commandId: CommandId.make(NodeCrypto.randomUUID()),
                createdAt: DateTime.formatIso(yield* DateTime.now),
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
          EnvironmentAuth.runtimeLayer.pipe(
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
          const result = yield* rpc[ORCHESTRATION_WS_METHODS.searchThreads]({
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
        const snapshot = yield* client.orchestration.snapshot({
          headers: { authorization: `Bearer ${token}` },
        });
        const thread = snapshot.threads.find((item) => item.id === flags.threadId);
        if (!thread) {
          return yield* new ThreadCliError({ detail: `Thread ${flags.threadId} was not found.` });
        }
        const command = {
          type: "thread.turn.start" as const,
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          threadId: thread.id,
          message: {
            messageId: MessageId.make(NodeCrypto.randomUUID()),
            role: "user" as const,
            text,
            attachments: [],
          },
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        };
        const result = yield* withEnvironmentRpc({ origin, sessionId }, (rpc) =>
          rpc[ORCHESTRATION_WS_METHODS.dispatchCommand](command),
        );
        yield* Console.log(yield* encodeCliJson(result));
      }),
    ),
  ),
);

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
          const item = yield* rpc[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: ThreadId.make(flags.threadId),
            turnLimit: Option.getOrUndefined(flags.turns) ?? 10,
          }).pipe(
            Stream.filterMap((item) =>
              item.kind === "snapshot" ? Result.succeed(item.snapshot) : Result.failVoid,
            ),
            Stream.runHead,
            Effect.timeout("15 seconds"),
          );
          if (Option.isNone(item)) {
            return yield* new ThreadCliError({ detail: "No thread snapshot was received." });
          }
          yield* Console.log(
            yield* encodeCliJson({
              threadId: item.value.thread.id,
              messages: item.value.thread.messages.map((message) => ({
                id: message.id,
                role: message.role,
                text: message.text,
                streaming: message.streaming,
                createdAt: message.createdAt,
              })),
              hasMore: item.value.page?.hasMore ?? false,
            }),
          );
        }),
      ),
    ),
  ),
);

const threadSummary = (thread: {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly latestTurn: { readonly turnId: string; readonly state: string } | null;
  readonly updatedAt: string;
}) => ({
  threadId: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  branch: thread.branch,
  cwd: thread.worktreePath,
  latestTurn: thread.latestTurn,
  updatedAt: thread.updatedAt,
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
        const snapshot = yield* client.orchestration.snapshot({
          headers: { authorization: `Bearer ${token}` },
        });
        const threads = snapshot.threads
          .filter((thread) => thread.deletedAt === null)
          .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
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
        const snapshot = yield* client.orchestration.snapshot({
          headers: { authorization: `Bearer ${token}` },
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
          const thread = yield* rpc[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
            Stream.filterMap((item) => {
              const entry =
                item.kind === "snapshot"
                  ? item.snapshot.snapshotSequence >= afterSequence
                    ? item.snapshot.threads.find((thread) => thread.id === flags.threadId)
                    : undefined
                  : item.kind === "thread-upserted" &&
                      item.sequence >= afterSequence &&
                      item.thread.id === flags.threadId
                    ? item.thread
                    : undefined;
              return entry?.latestTurn && entry.latestTurn.state !== "running"
                ? Result.succeed(entry)
                : Result.failVoid;
            }),
            Stream.runHead,
            Effect.timeout(`${timeoutSeconds} seconds`),
            Effect.catchTag(
              "TimeoutError",
              () =>
                new ThreadCliError({
                  detail: `Timed out waiting for thread ${flags.threadId} after ${timeoutSeconds} seconds.`,
                }),
            ),
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
