import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  AGENT_EXPOSED_API_NAMES,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "../../../config.ts";
import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as RemoteOpenTargets from "../../../environment/RemoteOpenTargets.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as Keybindings from "../../../keybindings.ts";
import { OrchestrationEngineLive } from "../../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as ExternalLauncher from "../../../process/externalLauncher.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as WorkspaceEntries from "../../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { API_BRIDGE_OPERATION_NAMES } from "./handlers.ts";

const environmentId = EnvironmentId.make("environment-mcp-api-test");
const helperThreadId = ThreadId.make("thread-t3-chat-helper");
const targetProjectId = ProjectId.make("project-casino");
const createdAt = "2026-01-01T00:00:00.000Z";
const helperCapabilities: ReadonlySet<McpInvocationContext.McpCapability> = new Set([
  "preview",
  "environment",
]);
const previewOnlyCapabilities: ReadonlySet<McpInvocationContext.McpCapability> = new Set([
  "preview",
]);

const invocationFor = (
  capabilities: ReadonlySet<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  threadId: helperThreadId,
  providerSessionId: "provider-session-mcp-api-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities,
  issuedAt: 1,
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-api-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const orchestrationLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
);

const unusedServicesLayer = Layer.mergeAll(
  Layer.succeed(
    CheckpointDiffQuery.CheckpointDiffQuery,
    CheckpointDiffQuery.CheckpointDiffQuery.of({
      getTurnDiff: () => Effect.die("unused"),
      getFullThreadDiff: () => Effect.die("unused"),
    }),
  ),
  Layer.succeed(
    WorkspaceEntries.WorkspaceEntries,
    WorkspaceEntries.WorkspaceEntries.of({
      browse: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
      search: () => Effect.die("unused"),
      searchContents: () => Effect.die("unused"),
      refresh: () => Effect.die("unused"),
    }),
  ),
  Layer.succeed(
    WorkspaceFileSystem.WorkspaceFileSystem,
    WorkspaceFileSystem.WorkspaceFileSystem.of({
      readFile: () => Effect.die("unused"),
      writeFile: () => Effect.die("unused"),
    }),
  ),
  Layer.succeed(
    ServerEnvironment.ServerEnvironment,
    ServerEnvironment.ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.die("unused"),
    }),
  ),
  Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
    getDescriptor: () => Effect.die("unused"),
  } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
  Layer.succeed(ProviderRegistry.ProviderRegistry, {
    getProviders: Effect.die("unused"),
  } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
  Layer.succeed(ExternalLauncher.ExternalLauncher, {
    resolveAvailableEditors: () => Effect.die("unused"),
  } as unknown as ExternalLauncher.ExternalLauncher["Service"]),
  Layer.succeed(RemoteOpenTargets.RemoteOpenTargets, {
    resolveTargets: () => Effect.die("unused"),
  } as unknown as RemoteOpenTargets.RemoteOpenTargets["Service"]),
);

const serviceLayers = Layer.mergeAll(orchestrationLayer, Keybindings.layer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(ServerSettings.layerTest(), unusedServicesLayer, WorkspacePaths.layer),
  ),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-api-toolkit-test-" })),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const TestLayer = McpHttpServer.ApiToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(serviceLayers),
);

const callApi = (
  operation: string,
  input?: unknown,
  capabilities: ReadonlySet<McpInvocationContext.McpCapability> = helperCapabilities,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({
        name: "api_call",
        arguments: { operation, ...(input === undefined ? {} : { input }) },
      })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocationFor(capabilities),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

const seedTargetProject = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-target-project-create"),
    projectId: targetProjectId,
    title: "Casino",
    workspaceRoot: "/tmp/t3-mcp-api-test/casino",
    createdAt,
  });
  yield* engine.dispatch({
    type: "project.meta.update",
    commandId: CommandId.make("cmd-target-project-seed-scripts"),
    projectId: targetProjectId,
    scripts: [
      {
        id: "setup-worktree",
        name: "Setup worktree",
        command: "vp i",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ],
  });
});

it("serves exactly the agent-exposed operations from the inventory", () => {
  expect([...API_BRIDGE_OPERATION_NAMES].sort()).toEqual([...AGENT_EXPOSED_API_NAMES].sort());
});

it.effect("rejects operations that are not in the agent-exposed inventory", () =>
  Effect.gen(function* () {
    const result = yield* callApi("server.updateServer", {});
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Unknown operation 'server.updateServer'"),
      },
    ]);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("denies credentials without the environment capability", () =>
  Effect.gen(function* () {
    const result = yield* callApi("orchestration.subscribeShell", {}, previewOnlyCapabilities);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("T3 Chat Helper") },
    ]);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("rejects typed-contract violations as invalid input", () =>
  Effect.gen(function* () {
    const result = yield* callApi("orchestration.dispatchCommand", {
      type: "project.meta.update",
    });
    expect(result.isError).toBe(true);
  }).pipe(Effect.provide(TestLayer)),
);

// The helper's real management flow: add a global worktree-setup action to
// the keybindings file, then dispatch project.meta.update to drop the
// project-level "Setup worktree" script it replaces.
it.effect("replaces a project-level Setup worktree action with a global action", () =>
  Effect.gen(function* () {
    yield* seedTargetProject;

    const upsert = yield* callApi("server.upsertKeybinding", {
      key: "mod+alt+s",
      command: "script.setup-worktree.run",
    });
    expect(upsert.isError).toBe(false);
    expect(upsert.structuredContent).toMatchObject({
      keybindings: expect.arrayContaining([
        expect.objectContaining({ command: "script.setup-worktree.run" }),
      ]),
    });

    const dispatch = yield* callApi("orchestration.dispatchCommand", {
      type: "project.meta.update",
      commandId: "cmd-remove-setup-worktree-script",
      projectId: targetProjectId,
      scripts: [],
    });
    expect(dispatch.isError).toBe(false);
    expect(dispatch.structuredContent).toMatchObject({ sequence: expect.any(Number) });

    const shell = yield* callApi("orchestration.subscribeShell", {});
    expect(shell.isError).toBe(false);
    const snapshot = shell.structuredContent as {
      readonly projects: ReadonlyArray<{
        readonly id: string;
        readonly scripts: ReadonlyArray<unknown>;
      }>;
    };
    const target = snapshot.projects.find((project) => project.id === targetProjectId);
    expect(target).toBeDefined();
    expect(target?.scripts).toEqual([]);
  }).pipe(Effect.provide(TestLayer)),
);

// Serves the full production MCP layer over HTTP to pin endpoint separation:
// the standard endpoint must never list the API bridge, and the helper
// endpoint must refuse credentials that lack the environment capability.
const helperToken = "helper-bearer-token";
const previewToken = "preview-bearer-token";

const stubRegistryLayer = Layer.succeed(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.McpSessionRegistry.of({
    issue: () => Effect.die("unused"),
    resolve: (rawToken) =>
      Effect.succeed(
        rawToken === helperToken
          ? invocationFor(helperCapabilities)
          : rawToken === previewToken
            ? invocationFor(previewOnlyCapabilities)
            : undefined,
      ),
    touch: () => Effect.void,
    revokeProviderSession: () => Effect.void,
    revokeThread: () => Effect.void,
    revokeAll: Effect.void,
  }),
);

const HttpTestLayer = HttpRouter.serve(
  McpHttpServer.layer.pipe(
    Layer.provide(stubRegistryLayer),
    Layer.provide(PreviewAutomationBroker.layer),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(serviceLayers), Layer.provideMerge(NodeHttpServer.layerTest));

const decodeToolsListPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.optional(
        Schema.Struct({
          tools: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
        }),
      ),
    }),
  ),
);

const listTools = (path: string, token: string) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const headers = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    };
    const initializeResponse = yield* httpClient.post(path, {
      headers,
      body: HttpBody.text(
        `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-api-test","version":"1.0.0"}}}`,
        "application/json",
      ),
    });
    if (initializeResponse.status !== 200) {
      return { status: initializeResponse.status, toolNames: [] as ReadonlyArray<string> };
    }
    const sessionHeaders = {
      ...headers,
      "mcp-session-id": initializeResponse.headers["mcp-session-id"]!,
      "mcp-protocol-version": "2025-06-18",
    };
    yield* httpClient.post(path, {
      headers: sessionHeaders,
      body: HttpBody.text(
        `{"jsonrpc":"2.0","method":"notifications/initialized"}`,
        "application/json",
      ),
    });
    const listResponse = yield* httpClient.post(path, {
      headers: sessionHeaders,
      body: HttpBody.text(
        `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
        "application/json",
      ),
    });
    const body = yield* listResponse.text;
    const payloadText = body.startsWith("{")
      ? body
      : (body
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.slice("data:".length)
          .trim() ?? "{}");
    const payload = yield* decodeToolsListPayload(payloadText);
    return {
      status: listResponse.status,
      toolNames: (payload.result?.tools ?? []).map((tool) => tool.name),
    };
  });

it.effect("lists the API bridge only on the helper endpoint", () =>
  Effect.gen(function* () {
    const standard = yield* listTools(McpInvocationContext.MCP_HTTP_PATH, previewToken);
    expect(standard.status).toBe(200);
    expect(standard.toolNames).toContain("preview_status");
    expect(standard.toolNames).not.toContain("api_call");

    const helper = yield* listTools(McpInvocationContext.MCP_HELPER_HTTP_PATH, helperToken);
    expect(helper.status).toBe(200);
    expect(helper.toolNames).toContain("api_call");
    expect(helper.toolNames).toContain("preview_status");

    const rejected = yield* listTools(McpInvocationContext.MCP_HELPER_HTTP_PATH, previewToken);
    expect(rejected.status).toBe(401);
  }).pipe(Effect.provide(HttpTestLayer)),
);
