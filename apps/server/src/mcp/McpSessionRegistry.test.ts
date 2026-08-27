import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServer } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const helperRoot = "/tmp/t3-mcp-registry-test/t3code";
const helperProjectId = ProjectId.make("project-helper");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: { _tag: "TcpAddress", hostname, port },
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});
const fakeServerConfig = { t3CodeProjectDir: helperRoot } as ServerConfig.ServerConfig["Service"];

interface ProjectionStubOptions {
  readonly threadProjects?: Readonly<Record<string, ProjectId>>;
  readonly failReads?: boolean;
}

const makeProjectionStub = (options: ProjectionStubOptions = {}) =>
  ({
    getThreadShellById: (threadId: ThreadId) =>
      options.failReads
        ? Effect.fail(
            new PersistenceSqlError({ operation: "test.read", detail: "projection unavailable" }),
          )
        : Effect.succeed(
            options.threadProjects?.[threadId] === undefined
              ? Option.none()
              : Option.some({ id: threadId, projectId: options.threadProjects[threadId] }),
          ),
    getActiveProjectByWorkspaceRoot: (workspaceRoot: string) =>
      Effect.succeed(
        workspaceRoot === helperRoot ? Option.some({ id: helperProjectId }) : Option.none(),
      ),
  }) as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];

const makeRegistry = (
  now: () => number,
  httpServer = fakeHttpServer,
  projectionStub: ProjectionStubOptions = {},
) =>
  McpSessionRegistry.__testing
    .make({
      now,
      livenessWindowMs: 100,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provideService(ServerConfig.ServerConfig, fakeServerConfig),
      Effect.provideService(
        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
        makeProjectionStub(projectionStub),
      ),
      Effect.provide(NodeServices.layer),
    );

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.threadId).toBe(threadId);

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["localhost", "http://localhost:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("issues helper-thread credentials with the environment capability and endpoint", () =>
  Effect.gen(function* () {
    const helperThreadId = ThreadId.make("thread-helper");
    const registry = yield* makeRegistry(() => 1_000, fakeHttpServer, {
      threadProjects: { [helperThreadId]: helperProjectId },
    });
    const issued = yield* registry.issue({
      threadId: helperThreadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp/helper");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const resolved = yield* registry.resolve(token);
    expect(resolved?.capabilities.has("environment")).toBe(true);
    expect(resolved?.capabilities.has("preview")).toBe(true);
  }),
);

it.effect("issues non-helper credentials without the environment capability", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-ordinary");
    const registry = yield* makeRegistry(() => 1_000, fakeHttpServer, {
      threadProjects: { [threadId]: ProjectId.make("project-ordinary") },
    });
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const resolved = yield* registry.resolve(token);
    expect(resolved?.capabilities.has("environment")).toBe(false);
  }),
);

it.effect("withholds the environment capability when the projection read fails", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000, fakeHttpServer, { failReads: true });
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-unreadable"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const resolved = yield* registry.resolve(token);
    expect(resolved?.capabilities.has("environment")).toBe(false);
  }),
);

it.effect("expires credentials once their session stops showing signs of life", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("keeps a credential alive across turns that never touch an MCP tool", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-3");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    // Well past the liveness window in total, but each turn reports in before
    // it lapses — this is the long-session case that used to lose the toolkit.
    for (let turn = 0; turn < 10; turn += 1) {
      timestamp += 99;
      yield* registry.touch(threadId);
    }

    expect((yield* registry.resolve(token))?.threadId).toBe(threadId);
  }),
);

it.effect("does not keep credentials of other threads alive", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-4"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    timestamp += 99;
    yield* registry.touch(ThreadId.make("thread-unrelated"));
    timestamp += 2;

    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);
