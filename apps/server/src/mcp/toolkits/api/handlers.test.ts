import { ScheduledTaskService } from "../../../scheduledTasks/ScheduledTaskService.ts";
import { VcsStatusBroadcaster } from "../../../vcs/VcsStatusBroadcaster.ts";
import { ProjectSetupScriptRunner } from "../../../project/ProjectSetupScriptRunner.ts";
import { GitWorkflowService } from "../../../git/GitWorkflowService.ts";
import { ProjectService } from "../../../project/ProjectService.ts";
import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import { ProviderAdapterRegistryV2 } from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  AGENT_EXPOSED_API_NAMES,
  AgentApiCallError,
  AuthSessionId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";
import { withEnvironmentRpc } from "../../../orchestration-v2/bootstrapRpcClient.ts";
import { persistServerRuntimeState } from "../../../serverRuntimeState.ts";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as DeviceService from "../../../device/DeviceService.ts";
import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "../../../config.ts";
import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as RemoteOpenTargets from "../../../environment/RemoteOpenTargets.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as Keybindings from "../../../keybindings.ts";
import * as ExternalLauncher from "../../../process/externalLauncher.ts";
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
vi.mock("../../../orchestration-v2/bootstrapRpcClient.ts", () => ({ withEnvironmentRpc: vi.fn() }));
const revokeSession = vi.fn(() => Effect.void);
const seedRuntime = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  yield* persistServerRuntimeState({
    path: config.serverRuntimeStatePath,
    state: {
      version: 1,
      pid: process.pid,
      port: 12345,
      origin: "http://127.0.0.1:12345",
      startedAt: "2026-01-01T00:00:00.000Z",
    },
  });
});
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
  clientCapabilities: {},
  clientInfo: { name: "mcp-api-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-api-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

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
    issueSession: () => Effect.succeed({ sessionId: AuthSessionId.make("helper-api-session") }),
    revokeSession,
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

const serviceLayers = Keybindings.layer.pipe(
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

it.effect("requires the running server for worktree launches", () =>
  Effect.gen(function* () {
    const result = yield* callApi("orchestration.launchThread", {
      commandId: "cmd-bootstrap",
      threadId: "thread-bootstrap",
      projectId: targetProjectId,
      title: "Bootstrap thread",
      modelSelection: { instanceId: "codex", model: "gpt-6-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "worktree", baseRef: "main" },
      initialMessage: { text: "Start in a worktree", attachments: [] },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("running T3 Code server is required") },
    ]);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("forwards V2 dispatch to the live server and revokes its temporary credential", () =>
  Effect.gen(function* () {
    yield* seedRuntime;
    const dispatch = vi.fn(() => Effect.succeed({ sequence: 17 }));
    const forwardRpc: typeof withEnvironmentRpc = <A, E, R>(
      _input: Parameters<typeof withEnvironmentRpc>[0],
      run: Parameters<typeof withEnvironmentRpc<A, E, R>>[1],
    ) =>
      run({ "orchestration.dispatchCommand": dispatch } as unknown as Parameters<
        typeof run
      >[0]).pipe(
        Effect.provide(
          Layer.mock(RpcClient.Protocol)({
            supportsAck: false,
            supportsTransferables: false,
            codecFor: Schema.toCodecJson,
          }),
        ),
        Effect.scoped,
      );
    vi.mocked(withEnvironmentRpc).mockImplementation(forwardRpc);
    revokeSession.mockClear();
    const command = { type: "thread.archive", commandId: "cmd-archive", threadId: "thread-target" };
    const result = yield* callApi("orchestration.dispatchCommand", command);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ sequence: 17 });
    expect(dispatch).toHaveBeenCalledWith(command);
    expect(revokeSession).toHaveBeenCalledWith("helper-api-session");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("revokes its temporary credential when the live RPC fails", () =>
  Effect.gen(function* () {
    yield* seedRuntime;
    vi.mocked(withEnvironmentRpc).mockImplementation(() =>
      Effect.fail(
        new AgentApiCallError({
          operation: "projects.mutate",
          reason: "failed",
          message: "offline",
        }),
      ),
    );
    revokeSession.mockClear();
    const result = yield* callApi("projects.mutate", {
      type: "project.update",
      commandId: "cmd-project-update",
      projectId: targetProjectId,
      scripts: [],
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("offline") }]);
    expect(revokeSession).toHaveBeenCalledWith("helper-api-session");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("updates global keybindings through the helper bridge", () =>
  Effect.gen(function* () {
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
    Layer.provide(Layer.mock(DeviceService.DeviceService)({})),
    Layer.provide(Layer.mock(ScheduledTaskService)({})),
    Layer.provide(Layer.mock(VcsStatusBroadcaster)({})),
    Layer.provide(Layer.mock(ProjectSetupScriptRunner)({})),
    Layer.provide(Layer.mock(GitWorkflowService)({})),
    Layer.provide(Layer.mock(ProjectService)({})),
    Layer.provide(Layer.mock(OrchestratorV2)({})),
    Layer.provide(Layer.mock(ProviderAdapterRegistryV2)({})),
    Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
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
    expect(standard.toolNames).toContain("device_list");
    expect(standard.toolNames).toContain("list_thread_pull_requests");
    expect(standard.toolNames).not.toContain("api_call");

    const helper = yield* listTools(McpInvocationContext.MCP_HELPER_HTTP_PATH, helperToken);
    expect(helper.status).toBe(200);
    expect(helper.toolNames).toContain("api_call");
    expect(helper.toolNames).toContain("preview_status");
    expect(helper.toolNames).toEqual(expect.arrayContaining([...standard.toolNames]));

    const rejected = yield* listTools(McpInvocationContext.MCP_HELPER_HTTP_PATH, previewToken);
    expect(rejected.status).toBe(401);
  }).pipe(Effect.provide(HttpTestLayer)),
);
