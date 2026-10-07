import {
  AGENT_EXPOSED_API_NAMES,
  AgentApiCallError,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  Project,
  ProjectMutation,
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2RpcSchemas,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadProjection,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
  ServerConfig as ServerConfigContract,
  ServerRemoveKeybindingInput,
  ServerRemoveKeybindingResult,
  ServerSettings as ServerSettingsContract,
  ServerSettingsPatch,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Result from "effect/Result";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "../../../config.ts";
import * as Keybindings from "../../../keybindings.ts";
import { withEnvironmentRpc } from "../../../orchestration-v2/bootstrapRpcClient.ts";
import { loadServerConfig } from "../../../serverConfigSnapshot.ts";
import { readPersistedServerRuntimeState } from "../../../serverRuntimeState.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as WorkspaceEntries from "../../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ApiToolkit } from "./tools.ts";

const EmptyInput = Schema.Struct({});

const isAgentApiCallError = Schema.is(AgentApiCallError);

const describeFailure = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const tag = "_tag" in error && typeof error._tag === "string" ? error._tag : undefined;
    const message =
      "message" in error && typeof error.message === "string" ? error.message : undefined;
    if (tag !== undefined && message !== undefined) return `${tag}: ${message}`;
    if (message !== undefined) return message;
  }
  return String(error);
};

/**
 * Wraps one typed operation: decode the raw input with the operation's
 * contract schema, run it, encode the result back to wire-safe JSON. Every
 * failure surfaces as a bounded `AgentApiCallError`.
 */
const makeRunner = <I extends Schema.Top, O extends Schema.Top, E, R>(
  operation: string,
  input: I,
  output: O,
  run: (value: I["Type"]) => Effect.Effect<O["Type"], E, R>,
) => {
  const decode = Schema.decodeUnknownEffect(input);
  const encode = Schema.encodeUnknownEffect(output);
  return (raw: unknown) =>
    decode(raw ?? {}).pipe(
      Effect.mapError(
        (error) =>
          new AgentApiCallError({ operation, reason: "invalid_input", message: error.message }),
      ),
      Effect.flatMap((value) =>
        run(value).pipe(
          Effect.mapError((error) =>
            isAgentApiCallError(error)
              ? error
              : new AgentApiCallError({
                  operation,
                  reason: "failed",
                  message: describeFailure(error),
                }),
          ),
        ),
      ),
      Effect.flatMap((result) => encode(result).pipe(Effect.orDie)),
    );
};

// Use the live dispatcher so helper mutations share startup gating, attachment
// intake, worktree preparation, and event delivery with connected clients.
const withLiveRpc = <A, E, R>(
  operation: string,
  run: Parameters<typeof withEnvironmentRpc<A, E, R>>[1],
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const runtime = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtime)) {
      return yield* new AgentApiCallError({
        operation,
        reason: "unavailable",
        message: "The running T3 Code server is required for orchestration operations.",
      });
    }
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* Effect.acquireUseRelease(
      auth.issueSession({
        scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        label: "t3 helper API bridge",
      }),
      (issued) =>
        withEnvironmentRpc({ origin: runtime.value.origin, sessionId: issued.sessionId }, run),
      (issued) => auth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
    );
  });

const runners = {
  [WS_METHODS.serverGetConfig]: makeRunner(
    WS_METHODS.serverGetConfig,
    EmptyInput,
    ServerConfigContract,
    () => loadServerConfig,
  ),
  [WS_METHODS.serverGetSettings]: makeRunner(
    WS_METHODS.serverGetSettings,
    EmptyInput,
    ServerSettingsContract,
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettings.ServerSettingsService;
        return ServerSettings.redactServerSettingsForClient(yield* serverSettings.getSettings);
      }),
  ),
  [WS_METHODS.serverUpdateSettings]: makeRunner(
    WS_METHODS.serverUpdateSettings,
    Schema.Struct({ patch: ServerSettingsPatch }),
    ServerSettingsContract,
    ({ patch }) =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettings.ServerSettingsService;
        return ServerSettings.redactServerSettingsForClient(
          yield* serverSettings.updateSettings(patch),
        );
      }),
  ),
  [WS_METHODS.serverUpsertKeybinding]: makeRunner(
    WS_METHODS.serverUpsertKeybinding,
    ServerUpsertKeybindingInput,
    ServerUpsertKeybindingResult,
    (rule) =>
      Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return { keybindings: yield* keybindings.upsertKeybindingRule(rule), issues: [] };
      }),
  ),
  [WS_METHODS.serverRemoveKeybinding]: makeRunner(
    WS_METHODS.serverRemoveKeybinding,
    ServerRemoveKeybindingInput,
    ServerRemoveKeybindingResult,
    (rule) =>
      Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        return { keybindings: yield* keybindings.removeKeybindingRule(rule), issues: [] };
      }),
  ),
  [WS_METHODS.projectsSearchEntries]: makeRunner(
    WS_METHODS.projectsSearchEntries,
    ProjectSearchEntriesInput,
    ProjectSearchEntriesResult,
    (input) =>
      Effect.flatMap(WorkspaceEntries.WorkspaceEntries, (workspaceEntries) =>
        workspaceEntries.search(input),
      ),
  ),
  [WS_METHODS.projectsSearchContents]: makeRunner(
    WS_METHODS.projectsSearchContents,
    ProjectSearchContentsInput,
    ProjectSearchContentsResult,
    (input) =>
      Effect.flatMap(WorkspaceEntries.WorkspaceEntries, (workspaceEntries) =>
        workspaceEntries.searchContents(input),
      ),
  ),
  [WS_METHODS.projectsListEntries]: makeRunner(
    WS_METHODS.projectsListEntries,
    ProjectListEntriesInput,
    ProjectListEntriesResult,
    (input) =>
      Effect.flatMap(WorkspaceEntries.WorkspaceEntries, (workspaceEntries) =>
        workspaceEntries.list(input),
      ),
  ),
  [WS_METHODS.projectsReadFile]: makeRunner(
    WS_METHODS.projectsReadFile,
    ProjectReadFileInput,
    ProjectReadFileResult,
    (input) =>
      Effect.flatMap(WorkspaceFileSystem.WorkspaceFileSystem, (workspaceFileSystem) =>
        workspaceFileSystem.readFile(input),
      ),
  ),
  [WS_METHODS.projectsWriteFile]: makeRunner(
    WS_METHODS.projectsWriteFile,
    ProjectWriteFileInput,
    ProjectWriteFileResult,
    (input) =>
      Effect.flatMap(WorkspaceFileSystem.WorkspaceFileSystem, (workspaceFileSystem) =>
        workspaceFileSystem.writeFile(input),
      ),
  ),
  [WS_METHODS.projectsMutate]: makeRunner(
    WS_METHODS.projectsMutate,
    ProjectMutation,
    Project,
    (input) =>
      withLiveRpc(WS_METHODS.projectsMutate, (rpc) => rpc[WS_METHODS.projectsMutate](input)),
  ),
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: makeRunner(
    ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
    OrchestrationV2RpcSchemas.dispatchCommand.input,
    OrchestrationV2RpcSchemas.dispatchCommand.output,
    (input) =>
      withLiveRpc(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, (rpc) =>
        rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](input),
      ),
  ),
  [ORCHESTRATION_V2_WS_METHODS.launchThread]: makeRunner(
    ORCHESTRATION_V2_WS_METHODS.launchThread,
    OrchestrationV2RpcSchemas.launchThread.input,
    OrchestrationV2RpcSchemas.launchThread.output,
    (input) =>
      withLiveRpc(ORCHESTRATION_V2_WS_METHODS.launchThread, (rpc) =>
        rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](input),
      ),
  ),
  [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: makeRunner(
    ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
    OrchestrationV2RpcSchemas.getThreadProjection.input,
    OrchestrationV2RpcSchemas.getThreadProjection.output,
    (input) =>
      withLiveRpc(ORCHESTRATION_V2_WS_METHODS.getThreadProjection, (rpc) =>
        rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection](input),
      ),
  ),
  [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: makeRunner(
    ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
    OrchestrationV2RpcSchemas.getTurnDiff.input,
    OrchestrationV2RpcSchemas.getTurnDiff.output,
    (input) =>
      Effect.flatMap(CheckpointDiffQuery.CheckpointDiffQuery, (checkpointDiffQuery) =>
        checkpointDiffQuery.getTurnDiff(input),
      ),
  ),
  [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: makeRunner(
    ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff,
    OrchestrationV2RpcSchemas.getFullThreadDiff.input,
    OrchestrationV2RpcSchemas.getFullThreadDiff.output,
    (input) =>
      Effect.flatMap(CheckpointDiffQuery.CheckpointDiffQuery, (checkpointDiffQuery) =>
        checkpointDiffQuery.getFullThreadDiff(input),
      ),
  ),
  [ORCHESTRATION_V2_WS_METHODS.searchThreads]: makeRunner(
    ORCHESTRATION_V2_WS_METHODS.searchThreads,
    OrchestrationSearchThreadsInput,
    OrchestrationSearchThreadsResult,
    (input) =>
      withLiveRpc(ORCHESTRATION_V2_WS_METHODS.searchThreads, (rpc) =>
        rpc[ORCHESTRATION_V2_WS_METHODS.searchThreads](input),
      ),
  ),
  // Stream operations return one current snapshot through the request/response bridge.
  [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: makeRunner(
    ORCHESTRATION_V2_WS_METHODS.subscribeShell,
    OrchestrationV2RpcSchemas.subscribeShell.input,
    OrchestrationV2ShellSnapshot,
    () =>
      withLiveRpc(ORCHESTRATION_V2_WS_METHODS.subscribeShell, (rpc) =>
        rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
          Stream.filterMap((item) =>
            item.kind === "snapshot" ? Result.succeed(item.snapshot) : Result.failVoid,
          ),
          Stream.runHead,
          Effect.flatMap(
            Option.match({
              onSome: Effect.succeed,
              onNone: () =>
                Effect.fail(
                  new AgentApiCallError({
                    operation: ORCHESTRATION_V2_WS_METHODS.subscribeShell,
                    reason: "failed",
                    message: "Shell stream ended without a snapshot.",
                  }),
                ),
            }),
          ),
        ),
      ),
  ),
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: makeRunner(
    ORCHESTRATION_V2_WS_METHODS.subscribeThread,
    OrchestrationV2RpcSchemas.subscribeThread.input,
    OrchestrationV2ThreadProjection,
    (input) =>
      withLiveRpc(ORCHESTRATION_V2_WS_METHODS.subscribeThread, (rpc) =>
        rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId: input.threadId }),
      ),
  ),
};

/** Operations served by the bridge; must cover the agent-exposed inventory. */
export const API_BRIDGE_OPERATION_NAMES: ReadonlyArray<string> = Object.keys(runners);

const lookupRunner = (operation: string) =>
  Object.hasOwn(runners, operation) ? runners[operation as keyof typeof runners] : undefined;

/**
 * The API bridge is registered only on the helper MCP endpoint, whose
 * transport already requires the `environment` capability; this re-check
 * keeps the tool safe against ever being mounted elsewhere. The capability
 * is granted at credential issuance exclusively to T3 Chat Helper threads.
 */
const requireEnvironmentCapability = (operation: string) =>
  Effect.gen(function* () {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    if (!invocation.capabilities.has("environment")) {
      return yield* new AgentApiCallError({
        operation,
        reason: "unavailable",
        message:
          "api_call is only available to agent sessions running in the T3 Chat Helper project.",
      });
    }
  });

export const ApiToolkitHandlersLive = McpToolAccess.toLayer(ApiToolkit, {
  api_call: McpToolAccess.actsAsCaller(({ operation, input }) =>
    Effect.gen(function* () {
      const runner = lookupRunner(operation);
      if (runner === undefined) {
        return yield* new AgentApiCallError({
          operation,
          reason: "unknown_operation",
          message: `Unknown operation '${operation}'. Agent-exposed operations: ${AGENT_EXPOSED_API_NAMES.join(", ")}.`,
        });
      }
      yield* requireEnvironmentCapability(operation);
      return yield* runner(input);
    }),
  ),
});
