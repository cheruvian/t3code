import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe } from "vite-plus/test";
import { DEFAULT_MODEL, ThreadId } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

import codexMultiAgentWire from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import {
  buildCodexDeveloperInstructions,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import {
  buildTurnStartParams,
  hasConfiguredMcpServer,
  isRecoverableThreadResumeError,
  makeCodexSessionRuntime,
  openCodexThread,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

type TestClientMessage = {
  readonly id?: string | number;
  readonly method: string;
  readonly params?: unknown;
};

const encoder = new TextEncoder();

const makeCodexRuntimeHarness = Effect.fn("makeCodexRuntimeHarness")(function* () {
  const incoming = yield* Queue.unbounded<Uint8Array>();
  const reloadRequests = yield* Queue.unbounded<Required<Pick<TestClientMessage, "id">>>();
  const reloadCount = yield* Ref.make(0);
  const turnStartCount = yield* Ref.make(0);
  let nextTurn = 1;
  let remainder = "";

  const sendMessage = (message: unknown) =>
    Queue.offer(incoming, encoder.encode(`${JSON.stringify(message)}\n`)).pipe(Effect.asVoid);

  const respond = (request: Required<Pick<TestClientMessage, "id">>, result: unknown) =>
    sendMessage({ id: request.id, result });

  const handleMessage = Effect.fn("makeCodexRuntimeHarness.handleMessage")(function* (
    message: TestClientMessage,
  ) {
    switch (message.method) {
      case "initialize":
        if (message.id !== undefined) {
          yield* respond(message as Required<Pick<TestClientMessage, "id">>, {
            userAgent: "t3-codex-runtime-test/0.0.0",
            codexHome: "/tmp",
            platformFamily: "unix",
            platformOs: "linux",
          });
        }
        return;
      case "thread/start":
        if (message.id !== undefined) {
          yield* respond(
            message as Required<Pick<TestClientMessage, "id">>,
            codexMultiAgentWire.responses.threadStart,
          );
        }
        return;
      case "config/mcpServer/reload":
        if (message.id !== undefined) {
          yield* Ref.update(reloadCount, (count) => count + 1);
          yield* Queue.offer(reloadRequests, message as Required<Pick<TestClientMessage, "id">>);
        }
        return;
      case "turn/start":
        if (message.id !== undefined) {
          const turnNumber = nextTurn++;
          yield* Ref.update(turnStartCount, (count) => count + 1);
          yield* respond(message as Required<Pick<TestClientMessage, "id">>, {
            ...codexMultiAgentWire.responses.turnStart,
            turn: {
              ...codexMultiAgentWire.responses.turnStart.turn,
              id: `provider-turn-${turnNumber}`,
            },
          });
        }
        return;
      default:
        return;
    }
  });

  const stdin = Sink.forEach((chunk: Uint8Array) =>
    Effect.gen(function* () {
      remainder += new TextDecoder().decode(chunk, { stream: true });
      const lines = remainder.split("\n");
      remainder = lines.pop() ?? "";
      yield* Effect.forEach(
        lines,
        (line) => {
          const trimmed = line.trim();
          return trimmed.length === 0
            ? Effect.void
            : handleMessage(JSON.parse(trimmed) as TestClientMessage);
        },
        { discard: true },
      );
    }),
  );

  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin,
    stdout: Stream.fromQueue(incoming),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

  return {
    layer: Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.succeed(handle)),
    ),
    reloadRequests,
    reloadCount: Ref.get(reloadCount),
    turnStartCount: Ref.get(turnStartCount),
    respond,
  };
});

describe("CodexSessionRuntimeIdentifierGenerationError", () => {
  it("retains identifier purpose and the random source failure", () => {
    const cause = new Error("random source unavailable");
    const error = new CodexErrors.CodexAppServerIdentifierGenerationError({
      purpose: "provider-event",
      cause,
    });

    NodeAssert.equal(error.purpose, "provider-event");
    NodeAssert.strictEqual(error.cause, cause);
    NodeAssert.equal(
      error.message,
      "Failed to generate Codex App Server identifier for provider-event.",
    );
  });
});

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      createdAt: "2026-04-18T00:00:00.000Z",
      source: { session: "cli" },
      turns: [],
      status: {
        state: "idle",
        activeFlags: [],
      },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("buildTurnStartParams", () => {
  it("keeps invalid turn values only in the schema cause", () => {
    const secret = "codex-turn-input-secret-sentinel";
    const error = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        attachments: [
          {
            type: "image",
            url: { secret } as unknown as string,
          },
        ],
      }).pipe(Effect.flip),
    );
    const { cause, ...directDiagnostics } = error;

    NodeAssert.equal(error.operation, "decode-request-payload");
    NodeAssert.equal(error.method, "turn/start");
    NodeAssert.ok((error.issueCount ?? 0) > 0);
    NodeAssert.ok(error.issueKinds?.includes("Pointer"));
    NodeAssert.ok((error.maximumPathDepth ?? 0) > 0);
    NodeAssert.ok(Schema.isSchemaError(cause));
    NodeAssert.doesNotMatch(error.message, new RegExp(secret));
    NodeAssert.doesNotMatch(JSON.stringify(directDiagnostics), new RegExp(secret));
  });

  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("plan", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("default", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("reports the same fallback model and effort in settings and instructions", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Go",
        interactionMode: "default",
      }),
    );

    const settings = params.collaborationMode?.settings;
    NodeAssert.equal(settings?.model, DEFAULT_MODEL);
    NodeAssert.equal(settings?.reasoning_effort, "medium");
    NodeAssert.ok(settings?.developer_instructions?.includes(`as ${DEFAULT_MODEL} with medium`));
  });

  it.effect("routes approvals to the auto reviewer in auto mode", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto",
        prompt: "Ship it",
      });

      NodeAssert.deepStrictEqual(params, {
        threadId: "provider-thread-1",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
        input: [
          {
            type: "text",
            text: "Ship it",
          },
        ],
      });
    }),
  );

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });
});

describe("buildCodexDeveloperInstructions", () => {
  it("appends runtime info after the mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    NodeAssert.ok(instructions.startsWith(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS));
    NodeAssert.match(instructions, /T3 Code/);
    NodeAssert.match(instructions, /Codex harness/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with high reasoning effort/);
  });

  it("includes runtime info alongside plan mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("plan", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });

    NodeAssert.ok(instructions.startsWith(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS));
    NodeAssert.match(instructions, /as gpt-5\.3-codex with medium reasoning effort/);
  });

  it("varies with the model and effort of each turn", () => {
    const first = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });
    const second = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    NodeAssert.notEqual(first, second);
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("T3 browser developer instructions", () => {
  it("prefers the product-native preview tools in both collaboration modes", () => {
    for (const instructions of [
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
    ]) {
      NodeAssert.match(instructions, /t3-code/);
      NodeAssert.match(instructions, /preview_status/);
      NodeAssert.match(instructions, /preview_open/);
      NodeAssert.match(instructions, /Do not switch to global browser skills/);
    }
  });
});

describe("hasConfiguredMcpServer", () => {
  it("detects inline Codex MCP configuration arguments", () => {
    NodeAssert.equal(hasConfiguredMcpServer(undefined), false);
    NodeAssert.equal(hasConfiguredMcpServer(["--model", "gpt-5.4"]), false);
    NodeAssert.equal(
      hasConfiguredMcpServer(["-c", 'mcp_servers.t3-code.url="http://127.0.0.1/mcp"']),
      true,
    );
  });
});

describe("Codex MCP catalog reload", () => {
  it.effect("single-flights concurrent first sends and reuses the successful reload", () =>
    Effect.gen(function* () {
      const harness = yield* makeCodexRuntimeHarness();

      return yield* Effect.gen(function* () {
        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("thread-mcp-single-flight"),
          binaryPath: "/mock/codex",
          cwd: "/tmp",
          runtimeMode: "full-access",
          appServerArgs: ["-c", "mcp_servers.t3-code.url=http://127.0.0.1/mcp"],
        });
        yield* runtime.start();

        const releaseSends = yield* Deferred.make<void>();
        const firstReady = yield* Deferred.make<void>();
        const secondReady = yield* Deferred.make<void>();
        const send = (ready: Deferred.Deferred<void>, input: string) =>
          Deferred.succeed(ready, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSends)),
            Effect.andThen(runtime.sendTurn({ input })),
          );

        const firstSend = yield* send(firstReady, "first").pipe(Effect.forkScoped);
        const secondSend = yield* send(secondReady, "second").pipe(Effect.forkScoped);
        yield* Deferred.await(firstReady);
        yield* Deferred.await(secondReady);
        yield* Deferred.succeed(releaseSends, undefined);

        const reload = yield* Queue.take(harness.reloadRequests);
        const duplicateProbe = yield* Queue.take(harness.reloadRequests).pipe(
          Effect.timeoutOption("1 milli"),
          Effect.forkScoped,
        );
        yield* TestClock.adjust("1 milli");

        NodeAssert.equal((yield* Fiber.join(duplicateProbe))._tag, "None");
        NodeAssert.equal(yield* harness.reloadCount, 1);

        yield* harness.respond(reload, {});
        yield* Fiber.join(firstSend);
        yield* Fiber.join(secondSend);
        NodeAssert.equal(yield* harness.turnStartCount, 2);

        const laterSend = yield* runtime.sendTurn({ input: "later" }).pipe(Effect.forkScoped);
        const laterReloadProbe = yield* Queue.take(harness.reloadRequests).pipe(
          Effect.timeoutOption("1 milli"),
          Effect.forkScoped,
        );
        yield* TestClock.adjust("1 milli");

        NodeAssert.equal((yield* Fiber.join(laterReloadProbe))._tag, "None");
        yield* Fiber.join(laterSend);
        NodeAssert.equal(yield* harness.reloadCount, 1);
        NodeAssert.equal(yield* harness.turnStartCount, 3);
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(NodeServices.layer, harness.layer, TestClock.layer())),
      );
    }),
  );

  it.effect("times out a reload, ignores its late response, and retries independently", () =>
    Effect.gen(function* () {
      const harness = yield* makeCodexRuntimeHarness();

      return yield* Effect.gen(function* () {
        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("thread-mcp-reload-timeout"),
          binaryPath: "/mock/codex",
          cwd: "/tmp",
          runtimeMode: "full-access",
          appServerArgs: ["-c", "mcp_servers.t3-code.url=http://127.0.0.1/mcp"],
        });
        yield* runtime.start();

        const firstSend = yield* runtime.sendTurn({ input: "first" }).pipe(Effect.forkScoped);
        const timedOutReload = yield* Queue.take(harness.reloadRequests);
        const timeoutProbe = yield* Fiber.join(firstSend).pipe(
          Effect.timeoutOption("1 minute"),
          Effect.forkScoped,
        );
        yield* TestClock.adjust("1 minute");

        NodeAssert.equal((yield* Fiber.join(timeoutProbe))._tag, "Some");
        NodeAssert.equal(yield* harness.turnStartCount, 1);

        const retrySend = yield* runtime.sendTurn({ input: "retry" }).pipe(Effect.forkScoped);
        const retryReload = yield* Queue.take(harness.reloadRequests);
        NodeAssert.notEqual(retryReload.id, timedOutReload.id);

        yield* harness.respond(timedOutReload, {});
        yield* Effect.yieldNow;
        NodeAssert.equal((yield* Fiber.poll(retrySend))._tag, "None");
        NodeAssert.equal(yield* harness.turnStartCount, 1);

        yield* harness.respond(retryReload, {});
        yield* Fiber.join(retrySend);
        NodeAssert.equal(yield* harness.reloadCount, 2);
        NodeAssert.equal(yield* harness.turnStartCount, 2);
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(NodeServices.layer, harness.layer, TestClock.layer())),
      );
    }),
  );
});

describe("codexSessionAppServerArgs", () => {
  it("keeps the app-server subcommand when explicit args are provided", () => {
    NodeAssert.deepStrictEqual(codexSessionAppServerArgs(["-c", "model=gpt-5"], undefined), [
      "app-server",
      "-c",
      "model=gpt-5",
    ]);
  });

  it("keeps launch args when explicit app-server args are provided", () => {
    NodeAssert.deepStrictEqual(
      codexSessionAppServerArgs(
        ["-c", "mcp_servers.t3-code.url=http://127.0.0.1/mcp"],
        "--strict-config --enable foo",
      ),
      [
        "app-server",
        "--strict-config",
        "--enable",
        "foo",
        "-c",
        "mcp_servers.t3-code.url=http://127.0.0.1/mcp",
      ],
    );
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("openCodexThread", () => {
  it.effect("falls back to thread/start when resume fails recoverably", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
      const started = makeThreadOpenResponse("fresh-thread");
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "thread not found",
              }),
            );
          }
          return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };

      const opened = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      });

      NodeAssert.equal(opened.thread.id, "fresh-thread");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["thread/resume", "thread/start"],
      );
    }),
  );

  it.effect("propagates non-recoverable resume failures", () =>
    Effect.gen(function* () {
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "timed out waiting for server",
              }),
            );
          }
          return Effect.succeed(
            makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };

      const error = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.equal(error.errorMessage, "timed out waiting for server");
    }),
  );
});
