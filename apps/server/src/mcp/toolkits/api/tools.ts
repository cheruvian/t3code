import { AgentApiCallError } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "../../../config.ts";
import * as RemoteOpenTargets from "../../../environment/RemoteOpenTargets.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as Keybindings from "../../../keybindings.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ExternalLauncher from "../../../process/externalLauncher.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as WorkspaceEntries from "../../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ServerConfig.ServerConfig,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  OrchestrationEngine.OrchestrationEngineService,
  CheckpointDiffQuery.CheckpointDiffQuery,
  Keybindings.Keybindings,
  ServerSettings.ServerSettingsService,
  WorkspaceEntries.WorkspaceEntries,
  WorkspaceFileSystem.WorkspaceFileSystem,
  WorkspacePaths.WorkspacePaths,
  ProviderRegistry.ProviderRegistry,
  ServerEnvironment.ServerEnvironment,
  EnvironmentAuth.EnvironmentAuth,
  ExternalLauncher.ExternalLauncher,
  RemoteOpenTargets.RemoteOpenTargets,
  FileSystem.FileSystem,
  Path.Path,
];

export const ApiCallTool = Tool.make("api_call", {
  description:
    "Call a typed T3 Code environment API by name. `operation` is an agent-exposed entry from the T3 Chat Helper project's api-inventory.json (for example `orchestration.dispatchCommand` or `server.updateSettings`); `input` must match that operation's typed contract. `orchestration.subscribeShell` and `orchestration.subscribeThread` return the current snapshot instead of a live stream. Only agent sessions running in the T3 Chat Helper project may call this tool.",
  parameters: Schema.Struct({
    operation: Schema.String,
    input: Schema.optional(Schema.Unknown),
  }),
  success: Schema.Unknown,
  failure: AgentApiCallError,
  dependencies,
})
  .annotate(Tool.Title, "Call T3 Code typed API")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ApiToolkit = Toolkit.make(ApiCallTool);
