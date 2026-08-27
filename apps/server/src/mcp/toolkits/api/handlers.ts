import {
  AGENT_EXPOSED_API_NAMES,
  AgentApiCallError,
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationRpcSchemas,
  OrchestrationThreadDetailSnapshot,
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

import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import * as Keybindings from "../../../keybindings.ts";
import { projectThreadDetailSnapshot } from "../../../orchestration/ActivityPayloadProjection.ts";
import {
  cleanupFailedUploadedAttachments,
  normalizeDispatchCommand,
} from "../../../orchestration/Normalizer.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { loadServerConfig } from "../../../serverConfigSnapshot.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as WorkspaceEntries from "../../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
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
  [ORCHESTRATION_WS_METHODS.dispatchCommand]: makeRunner(
    ORCHESTRATION_WS_METHODS.dispatchCommand,
    ClientOrchestrationCommand,
    OrchestrationRpcSchemas.dispatchCommand.output,
    (command) =>
      Effect.gen(function* () {
        const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
        const normalizedCommand = yield* normalizeDispatchCommand(command);
        return yield* orchestrationEngine
          .dispatch(normalizedCommand)
          .pipe(
            Effect.tapError(() => cleanupFailedUploadedAttachments(command, normalizedCommand)),
          );
      }),
  ),
  [ORCHESTRATION_WS_METHODS.getTurnDiff]: makeRunner(
    ORCHESTRATION_WS_METHODS.getTurnDiff,
    OrchestrationRpcSchemas.getTurnDiff.input,
    OrchestrationRpcSchemas.getTurnDiff.output,
    (input) =>
      Effect.flatMap(CheckpointDiffQuery.CheckpointDiffQuery, (checkpointDiffQuery) =>
        checkpointDiffQuery.getTurnDiff(input),
      ),
  ),
  [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: makeRunner(
    ORCHESTRATION_WS_METHODS.getFullThreadDiff,
    OrchestrationRpcSchemas.getFullThreadDiff.input,
    OrchestrationRpcSchemas.getFullThreadDiff.output,
    (input) =>
      Effect.flatMap(CheckpointDiffQuery.CheckpointDiffQuery, (checkpointDiffQuery) =>
        checkpointDiffQuery.getFullThreadDiff(input),
      ),
  ),
  [ORCHESTRATION_WS_METHODS.searchThreads]: makeRunner(
    ORCHESTRATION_WS_METHODS.searchThreads,
    OrchestrationRpcSchemas.searchThreads.input,
    OrchestrationRpcSchemas.searchThreads.output,
    (input) =>
      Effect.flatMap(ProjectionSnapshotQuery.ProjectionSnapshotQuery, (projectionSnapshotQuery) =>
        projectionSnapshotQuery.searchThreads(input),
      ),
  ),
  // Subscriptions are stateful socket streams; over this request/response
  // bridge they answer with the current snapshot instead.
  [ORCHESTRATION_WS_METHODS.subscribeShell]: makeRunner(
    ORCHESTRATION_WS_METHODS.subscribeShell,
    OrchestrationRpcSchemas.subscribeShell.input,
    OrchestrationRpcSchemas.getArchivedShellSnapshot.output,
    () =>
      Effect.flatMap(ProjectionSnapshotQuery.ProjectionSnapshotQuery, (projectionSnapshotQuery) =>
        projectionSnapshotQuery.getShellSnapshot(),
      ),
  ),
  [ORCHESTRATION_WS_METHODS.subscribeThread]: makeRunner(
    ORCHESTRATION_WS_METHODS.subscribeThread,
    OrchestrationRpcSchemas.subscribeThread.input,
    OrchestrationThreadDetailSnapshot,
    (input) =>
      Effect.gen(function* () {
        const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
        const snapshot = yield* projectionSnapshotQuery.getThreadDetailSnapshot(input.threadId);
        if (Option.isNone(snapshot)) {
          return yield* new AgentApiCallError({
            operation: ORCHESTRATION_WS_METHODS.subscribeThread,
            reason: "failed",
            message: `No active thread '${input.threadId}' was found.`,
          });
        }
        return projectThreadDetailSnapshot(snapshot.value);
      }),
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

export const ApiToolkitHandlersLive = ApiToolkit.toLayer({
  api_call: ({ operation, input }) =>
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
});
