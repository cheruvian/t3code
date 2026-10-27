import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { OpencodeClient, ToolPart } from "@opencode-ai/sdk/v2";
import {
  CheckpointId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  MessageId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import { OpenCodeSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

import {
  advanceOpenCodePromptAdmission,
  cancelOpenCodePromptAdmission,
  openCodeBoundaryAfterProviderTurn,
  openCodeChildPermissionRules,
  openCodePermissionRules,
  openCodePermissionRequestKind,
  openCodeToolProjectionKind,
  makeOpenCodeProtocolLogger,
  makeOpenCodeAdapterV2,
  OPENCODE_PROVIDER,
  reconcileOpenCodePromptAdmissionStatus,
} from "./adapter.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const OPEN_CODE_TEST_SETTINGS = Schema.decodeSync(OpenCodeSettings)({
  serverUrl: "http://test.invalid",
});

function promiseGate<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function asyncEventStream() {
  const values: Array<{ value: unknown; handled: ReturnType<typeof promiseGate<void>> }> = [];
  const waiters: Array<(value: IteratorResult<unknown>) => void> = [];
  let previousHandled: ReturnType<typeof promiseGate<void>> | undefined;
  let closed = false;
  return {
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined });
    },
    push(value: unknown) {
      const handled = promiseGate<void>();
      const waiter = waiters.shift();
      if (waiter) {
        previousHandled = handled;
        waiter({ done: false, value });
      } else values.push({ value, handled });
      return handled.promise;
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            previousHandled?.resolve();
            if (closed) return Promise.resolve({ done: true as const, value: undefined });
            const entry = values.shift();
            if (entry !== undefined) {
              previousHandled = entry.handled;
              return Promise.resolve({ done: false as const, value: entry.value });
            }
            return new Promise<IteratorResult<unknown>>((resolve) => waiters.push(resolve));
          },
        };
      },
    },
  };
}

const OPENCODE_TEST_SETTINGS = Schema.decodeUnknownSync(OpenCodeSettings)({});

function runtimePolicy(
  runtimeMode: ProviderAdapter.ProviderAdapterV2RuntimePolicy["runtimeMode"],
  override: Partial<ProviderAdapter.ProviderAdapterV2RuntimePolicy> = {},
): ProviderAdapter.ProviderAdapterV2RuntimePolicy {
  return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: null,
    ...override,
  });
}

function permissionAction(rules: ReturnType<typeof openCodePermissionRules>, permission: string) {
  return rules.findLast((rule) => rule.permission === "*" || rule.permission === permission)
    ?.action;
}

function providerTurn(input: {
  readonly id: string;
  readonly ordinal: number;
  readonly nativeId: string | null;
}): OrchestrationV2ProviderTurn {
  return {
    id: ProviderTurnId.make(input.id),
    providerThreadId: ProviderThreadId.make("provider-thread:opencode-test"),
    nodeId: NodeId.make(`node:${input.id}`),
    runAttemptId: null,
    nativeTurnRef:
      input.nativeId === null
        ? null
        : { driver: OPENCODE_PROVIDER, nativeId: input.nativeId, strength: "weak" },
    ordinal: input.ordinal,
    status: "completed",
    startedAt: null,
    completedAt: null,
  };
}

const makeOpenCodeRuntimeHarness = Effect.fn("makeOpenCodeRuntimeHarness")(function* (
  suffix: string,
  nativeSessionId: string,
  client: object,
  readInstructions: Effect.Effect<string> = Effect.succeed(""),
) {
  const instanceId = ProviderInstanceId.make(`opencode-${suffix}`);
  const threadId = ThreadId.make(`thread-opencode-${suffix}`);
  const modelSelection = {
    instanceId,
    model: "anthropic/claude-sonnet",
    options: [],
  };
  const policy = runtimePolicy("full-access", { cwd: "/workspace" });
  const adapter = yield* makeOpenCodeAdapterV2({
    instanceId,
    settings: OPEN_CODE_TEST_SETTINGS,
    environment: {},
  }).pipe(
    Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, {
      connectToOpenCodeServer: () => Effect.succeed({ url: "http://test.invalid", external: true }),
      createOpenCodeSdkClient: () => client,
    } as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"]),
    Effect.provideService(ProviderHost.ProviderHost, {
      paths: { cwd: "/workspace" },
      settings: {
        get: readInstructions.pipe(
          Effect.map((globalCustomInstructions) => ({ globalCustomInstructions })),
        ),
      },
      resolveAttachmentPath: () => null,
    } as unknown as ProviderHost.ProviderHost["Service"]),
  );
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make(`session-opencode-${suffix}`),
    modelSelection,
    runtimePolicy: policy,
  });
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection,
    runtimePolicy: policy,
  });
  const now = yield* DateTime.now;
  const startTurn = (
    text = "hello",
    startProviderThread: OrchestrationV2ProviderThread = providerThread,
  ) =>
    runtime.startTurn({
      appThread: {
        id: threadId,
        projectId: ProjectId.make(`project-opencode-${suffix}`),
        title: suffix,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId: RunId.make(`run-opencode-${suffix}`),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make(`attempt-opencode-${suffix}`),
      rootNodeId: NodeId.make(`node-opencode-${suffix}`),
      providerThread: startProviderThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make(`message-opencode-${suffix}`),
        text,
        attachments: [],
      },
      modelSelection,
      runtimePolicy: policy,
    });
  return {
    nativeSessionId,
    now,
    policy,
    providerThread,
    runId: RunId.make(`run-opencode-${suffix}`),
    runtime,
    startTurn,
    threadId,
  };
});

describe("OpenCodeAdapterV2", () => {
  it.effect(
    "reads current host instructions for each turn without replacing the user's message",
    () =>
      Effect.gen(function* () {
        const nativeEvents = asyncEventStream();
        let currentInstructions = "Use conventions A";
        const prompts: Array<{ system: string; parts: unknown; messageID: string }> = [];
        const harness = yield* makeOpenCodeRuntimeHarness(
          "host-instructions",
          "root",
          {
            event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
            session: {
              create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
              promptAsync: async (input: { system: string; parts: unknown; messageID: string }) => {
                prompts.push(input);
                return { data: true };
              },
            },
          },
          Effect.sync(() => currentInstructions),
        );
        for (const instruction of ["Use conventions A", "Use conventions B"]) {
          currentInstructions = instruction;
          yield* harness.startTurn("Keep my message");
          const settled = yield* harness.runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* Effect.promise(() =>
            nativeEvents.push({
              type: "message.updated",
              properties: {
                sessionID: "root",
                info: { id: prompts.at(-1)!.messageID, role: "user", time: { created: 1 } },
              },
            }),
          );
          yield* Effect.promise(() =>
            nativeEvents.push({
              type: "session.status",
              properties: { sessionID: "root", status: { type: "busy" } },
            }),
          );
          yield* Effect.promise(() =>
            nativeEvents.push({
              type: "session.status",
              properties: { sessionID: "root", status: { type: "idle" } },
            }),
          );
          yield* Fiber.join(settled);
        }
        assert.include(prompts[0]!.system, "Use conventions A");
        assert.include(prompts[1]!.system, "Use conventions B");
        assert.notInclude(prompts[1]!.system, "Use conventions A");
        for (const prompt of prompts)
          assert.deepEqual(prompt.parts, [{ type: "text", text: "Keep my message" }]);
      }).pipe(
        Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
        Effect.scoped,
      ),
  );

  it.effect.each(["completed", "failed", "unresolved", "unavailable", "reconnect"] as const)(
    "normalizes OpenCode step usage for %s turns",
    (ending) =>
      Effect.gen(function* () {
        const nativeEvents = asyncEventStream();
        let promptId = "";
        const harness = yield* makeOpenCodeRuntimeHarness(`usage-${ending}`, "root", {
          event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
          session: {
            create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
            promptAsync: async (input: { messageID: string }) => {
              promptId = input.messageID;
              return { data: true };
            },
            abort: async () => ({ data: true }),
            children: async () => ({ data: [] }),
          },
        });
        yield* harness.startTurn();
        const received = yield* harness.runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "message.updated",
            properties: {
              sessionID: "root",
              info: { id: promptId, role: "user", time: { created: 1 } },
            },
          }),
        );
        const step = (id: string, messageID = "assistant") => ({
          type: "message.part.updated",
          properties: {
            part: {
              type: "step-finish",
              id,
              sessionID: "root",
              messageID,
              reason: "stop",
              cost: 0.01,
              tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 4 } },
            },
          },
        });
        if (ending !== "unavailable") {
          yield* Effect.promise(() => nativeEvents.push(step("one")));
          yield* Effect.promise(() =>
            nativeEvents.push({
              type: "message.updated",
              properties: {
                sessionID: "root",
                info: {
                  id: "assistant",
                  role: "assistant",
                  time: { created: 1 },
                  parentID: promptId,
                },
              },
            }),
          );
          yield* Effect.promise(() => nativeEvents.push(step("one")));
          yield* Effect.promise(() => nativeEvents.push(step("two")));
          yield* Effect.promise(() =>
            nativeEvents.push({
              type: "message.part.removed",
              properties: { sessionID: "root", messageID: "assistant", partID: "one" },
            }),
          );
          yield* Effect.promise(() =>
            nativeEvents.push({
              type: "message.updated",
              properties: {
                sessionID: "root",
                info: {
                  id: "old-assistant",
                  role: "assistant",
                  time: { created: 1 },
                  parentID: "old-prompt",
                },
              },
            }),
          );
          yield* Effect.promise(() => nativeEvents.push(step("old", "old-assistant")));
        }
        if (ending === "unresolved")
          yield* Effect.promise(() => nativeEvents.push(step("unknown", "unknown-assistant")));
        if (ending === "reconnect") {
          yield* Effect.promise(() =>
            nativeEvents.push({ type: "server.connected", properties: {} }),
          );
          yield* Effect.promise(() =>
            nativeEvents.push({ type: "server.connected", properties: {} }),
          );
        }
        if (ending === "failed") {
          yield* Effect.promise(() =>
            nativeEvents.push({
              type: "session.error",
              properties: {
                sessionID: "root",
                error: { name: "UnknownError", data: { message: "failed" } },
              },
            }),
          );
        } else {
          yield* Effect.promise(() =>
            nativeEvents.push({
              type: "session.status",
              properties: { sessionID: "root", status: { type: "busy" } },
            }),
          );
          yield* Effect.promise(() =>
            nativeEvents.push({
              type: "session.status",
              properties: { sessionID: "root", status: { type: "idle" } },
            }),
          );
        }
        const events = yield* Fiber.join(received);
        const completed = events.findLast((event) => event.type === "provider_turn.updated");
        assert.deepEqual(
          completed?.providerTurn.turnTokenUsage,
          ending === "unavailable"
            ? { usageStatus: "unavailable", usageScope: "main_agent", hasSubagents: false }
            : {
                usageStatus: ending === "completed" ? "complete" : "partial",
                usageScope: "main_agent",
                inputTokens: 34,
                cachedInputTokens: 6,
                cacheCreationTokens: 8,
                outputTokens: 14,
                reasoningTokens: 4,
                hasSubagents: false,
              },
        );
      }).pipe(
        Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
        Effect.scoped,
      ),
  );

  it.effect.each(["permission", "question"] as const)(
    "cancels an undelivered %s reply at its deadline",
    (kind) =>
      Effect.gen(function* () {
        const nativeEvents = asyncEventStream();
        const called = promiseGate<void>();
        let signal: AbortSignal | undefined;
        let deliver = false;
        const harness = yield* makeOpenCodeRuntimeHarness(`reply-${kind}`, "root", {
          event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
          session: {
            create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
            promptAsync: async () => ({ data: true }),
            abort: async () => ({ data: true }),
            children: async () => ({ data: [] }),
          },
          [kind]: {
            reply: async (_input: unknown, options: { signal: AbortSignal }) => {
              if (deliver) return { data: true };
              signal = options.signal;
              called.resolve();
              return new Promise(() => {});
            },
          },
        });
        yield* harness.startTurn();
        const received = yield* harness.runtime.events.pipe(
          Stream.filter((event) => event.type === "runtime_request.updated"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: `${kind}.asked`,
            properties:
              kind === "permission"
                ? {
                    id: "request",
                    sessionID: "root",
                    permission: "bash",
                    patterns: ["*"],
                    always: [],
                    metadata: {},
                  }
                : {
                    id: "request",
                    sessionID: "root",
                    questions: [
                      {
                        header: "Choice",
                        question: "Which?",
                        options: [{ label: "Yes", description: "Proceed" }],
                      },
                    ],
                  },
          }),
        );
        const request = (yield* Fiber.join(received))[0]!.runtimeRequest;
        const response = {
          requestId: request.id,
          ...(kind === "permission"
            ? { decision: "accept" as const }
            : { answers: { Choice: "Yes" } }),
        };
        const reply = yield* harness.runtime
          .respondToRuntimeRequest(response)
          .pipe(Effect.exit, Effect.forkScoped);
        yield* Effect.promise(() => called.promise);
        yield* TestClock.adjust("10 seconds");
        assert.isTrue(Exit.isFailure(yield* Fiber.join(reply)));
        assert.isTrue(signal?.aborted);
        deliver = true;
        yield* harness.runtime.respondToRuntimeRequest(response);
      }).pipe(
        Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
        Effect.scoped,
      ),
  );

  it.effect("aborts external root and descendants before closing the event stream", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const nativeEvents = asyncEventStream();
      const calls: string[] = [];
      yield* makeOpenCodeRuntimeHarness("release", "root", {
        event: {
          subscribe: async (_input: unknown, options: { signal: AbortSignal }) => {
            options.signal.addEventListener("abort", () => {
              calls.push("stream.close");
              nativeEvents.close();
            });
            return { stream: nativeEvents.stream };
          },
        },
        session: {
          create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
          abort: async ({ sessionID }: { sessionID: string }) => {
            calls.push(`abort:${sessionID}`);
            return { data: true };
          },
          children: async ({ sessionID }: { sessionID: string }) => {
            calls.push(`children:${sessionID}`);
            return { data: sessionID === "root" ? [{ id: "child" }] : [] };
          },
        },
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* Scope.close(scope, Exit.void);
      assert.deepEqual(calls, [
        "abort:root",
        "children:root",
        "abort:child",
        "children:child",
        "stream.close",
      ]);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect.each(["enumeration", "abort", "not-found", "timeout"] as const)(
    "reports descendant cleanup %s",
    (failure) =>
      Effect.gen(function* () {
        const nativeEvents = asyncEventStream();
        const called = promiseGate<void>();
        let childSignal: AbortSignal | undefined;
        const harness = yield* makeOpenCodeRuntimeHarness(`cleanup-${failure}`, "root", {
          event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
          session: {
            create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
            promptAsync: async () => ({ data: true }),
            get: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
            messages: async () => ({ data: [] }),
            children: async ({ sessionID }: { sessionID: string }) => {
              if (failure === "enumeration") throw new Error("cannot enumerate");
              return { data: sessionID === "root" ? [{ id: "child" }] : [] };
            },
            abort: async (
              { sessionID }: { sessionID: string },
              options: { signal: AbortSignal },
            ) => {
              if (sessionID === "root") return { data: true };
              if (failure === "timeout" && childSignal?.aborted) return { data: true };
              childSignal = options.signal;
              called.resolve();
              if (failure === "timeout") {
                return new Promise(() => {});
              }
              if (failure === "not-found") throw { status: 404 };
              throw new Error("child abort failed");
            },
          },
        });
        yield* harness.startTurn();
        const snapshot = yield* harness.runtime.readThreadSnapshot({
          providerThread: harness.providerThread,
        });
        const stop = yield* harness.runtime
          .interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId: snapshot.providerTurns.at(-1)!.id,
          })
          .pipe(Effect.exit, Effect.forkScoped);
        if (failure === "timeout") {
          yield* Effect.promise(() => called.promise);
          yield* TestClock.adjust("15 seconds");
        }
        const result = yield* Fiber.join(stop);
        assert.equal(Exit.isSuccess(result), failure === "not-found");
        if (failure === "timeout") assert.isTrue(childSignal?.aborted);
      }).pipe(
        Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
        Effect.scoped,
      ),
  );

  // Event order from a live OpenCode 1.18.32 run of a `task` call with
  // background=true: the task part completes at launch, the root session
  // settles, and the child session stays busy until its own work ends.

  it.effect("titles OpenCode reads and searches from their input", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const nativeSessionId = "native-opencode-search";
      const harness = yield* makeOpenCodeRuntimeHarness("search-projection", nativeSessionId, {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        session: {
          create: async () => ({
            data: { id: nativeSessionId, time: { created: 1, updated: 1 } },
          }),
          promptAsync: async () => ({ data: true }),
        },
      });
      yield* harness.startTurn();
      const received = yield* harness.runtime.events.pipe(
        Stream.takeUntil(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
        ),
        Stream.runCollect,
        Effect.forkScoped,
      );
      for (const [tool, input, output] of [
        ["read", { filePath: "src/env.ts" }, "---\nfile body"],
        ["grep", { pattern: "TODO", path: "apps/web" }, "---\nfile body"],
        ["websearch", { query: "OpenCode documentation" }, "---\nfile body"],
        ["glob", { pattern: "missing", path: "apps/web" }, ""],
        ["codesearch", {}, " \n\t"],
      ] as const) {
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "message.part.updated",
            properties: {
              sessionID: nativeSessionId,
              part: {
                id: `part-${tool}`,
                sessionID: nativeSessionId,
                messageID: "assistant-search",
                type: "tool",
                callID: `call-${tool}`,
                tool,
                state: {
                  status: "completed",
                  input,
                  output,
                  title: tool,
                  metadata: {},
                  time: { start: 1, end: 2 },
                },
              },
            },
          }),
        );
      }
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.compacted",
          properties: { sessionID: nativeSessionId },
        }),
      );
      const items = (yield* Fiber.join(received)).flatMap((event) =>
        event.type === "turn_item.updated" ? [event.turnItem] : [],
      );
      const read = items.find((item) => item.type === "dynamic_tool");
      assert.equal(read?.title, "Read src/env.ts");
      const grep = items.find((item) => item.type === "file_search");
      assert.equal(grep?.title, "Searched TODO in web");
      assert.equal(grep?.type === "file_search" ? grep.pattern : null, "TODO");
      assert.deepEqual(grep?.type === "file_search" ? grep.results : null, [
        { fileName: "apps/web", preview: "---\nfile body" },
      ]);
      const webSearch = items.find((item) => item.type === "web_search");
      assert.deepEqual(webSearch?.type === "web_search" ? webSearch.patterns : null, [
        "OpenCode documentation",
      ]);
      assert.deepEqual(webSearch?.type === "web_search" ? webSearch.results : null, [
        { snippet: "---\nfile body" },
      ]);
      const emptyFileSearch = items.find(
        (item) => item.type === "file_search" && item.pattern === "missing",
      );
      assert.ok(emptyFileSearch?.type === "file_search");
      assert.equal(emptyFileSearch.results, undefined);
      const emptyWebSearch = items.find(
        (item) => item.type === "web_search" && item.patterns === undefined,
      );
      assert.ok(emptyWebSearch?.type === "web_search");
      assert.equal(emptyWebSearch.results, undefined);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("presents OpenCode MCP calls without treating remote tools as local edits", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const nativeSessionId = "native-opencode-mcp";
      let statusReads = 0;
      const harness = yield* makeOpenCodeRuntimeHarness("mcp-presentation", nativeSessionId, {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        session: {
          create: async () => ({ data: { id: nativeSessionId, time: { created: 1, updated: 1 } } }),
          promptAsync: async () => ({ data: true }),
        },
        mcp: {
          status: async () => {
            statusReads++;
            return {
              data: {
                "my.server_with_underscores": { status: "connected" },
                ambiguous: { status: "connected" },
                ambiguous_server: { status: "connected" },
                code: { status: "connected" },
                apply: { status: "connected" },
              },
            };
          },
        },
      });
      yield* harness.startTurn();
      const received = yield* harness.runtime.events.pipe(
        Stream.takeUntil(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
        ),
        Stream.runCollect,
        Effect.forkScoped,
      );
      for (const status of ["running", "completed", "error"] as const) {
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "message.part.updated",
            properties: {
              sessionID: nativeSessionId,
              part: {
                id: "mcp-part",
                sessionID: nativeSessionId,
                messageID: "mcp-assistant",
                type: "tool",
                callID: "mcp-call",
                tool: "my_server_with_underscores_edit_document",
                state: {
                  status,
                  input: { document: "remote-doc" },
                  title: "Edit remote document",
                  metadata: {},
                  output: "saved",
                  error: "failed",
                  time: { start: 1, end: 2 },
                },
              },
            },
          }),
        );
      }
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "message.part.updated",
          properties: {
            sessionID: nativeSessionId,
            part: {
              id: "ambiguous-part",
              sessionID: nativeSessionId,
              messageID: "mcp-assistant",
              type: "tool",
              callID: "ambiguous-call",
              tool: "ambiguous_server_edit_document",
              state: {
                status: "completed",
                input: {},
                title: "Ambiguous tool",
                metadata: {},
                output: "",
                time: { start: 1, end: 2 },
              },
            },
          },
        }),
      );
      for (const tool of ["code_search", "apply_patch"]) {
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "message.part.updated",
            properties: {
              sessionID: nativeSessionId,
              part: {
                id: `native-${tool}`,
                sessionID: nativeSessionId,
                messageID: "mcp-assistant",
                type: "tool",
                callID: `native-${tool}`,
                tool,
                state: {
                  status: "completed",
                  input: { query: "needle", filePath: "local.ts" },
                  title: `Native ${tool}`,
                  metadata: {},
                  output: "done",
                  time: { start: 1, end: 2 },
                },
              },
            },
          }),
        );
      }
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.compacted",
          properties: { sessionID: nativeSessionId },
        }),
      );
      const allItems = (yield* Fiber.join(received)).flatMap((event) =>
        event.type === "turn_item.updated" ? [event.turnItem] : [],
      );
      assert.equal(
        allItems.find((item) => item.title === "Native code_search")?.type,
        "web_search",
      );
      assert.equal(
        allItems.find((item) => item.title === "Native apply_patch")?.type,
        "file_change",
      );
      const items = allItems.filter((item) => item.type === "dynamic_tool");
      assert.deepEqual(
        items.slice(0, 3).map((item) => item.status),
        ["running", "completed", "failed"],
      );
      assert.deepEqual(
        items.slice(0, 3).map((item) => item.title),
        ["Edit remote document", "Edit remote document", "edit document"],
      );
      for (const item of items.slice(0, 3)) {
        assert.deepEqual(item.toolSource, {
          key: "mcp:my.server_with_underscores",
          name: "my.server with underscores",
          kind: "integration",
        });
        assert.deepEqual(item.input, { document: "remote-doc" });
      }
      assert.equal(items[3]?.toolName, "ambiguous_server_edit_document");
      assert.isUndefined(items[3]?.toolSource);
      assert.equal(statusReads, 1);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect.each(["failure", "timeout"] as const)("retries MCP status after %s", (failure) =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const called = promiseGate<void>();
      const sessionId = `mcp-status-${failure}`;
      let statusReads = 0;
      let signal: AbortSignal | undefined;
      const harness = yield* makeOpenCodeRuntimeHarness(sessionId, sessionId, {
        event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
        session: {
          create: async () => ({ data: { id: sessionId, time: { created: 1, updated: 1 } } }),
          promptAsync: async () => ({ data: true }),
        },
        mcp: {
          status: async (_input: unknown, options: { signal?: AbortSignal }) => {
            statusReads++;
            if (statusReads === 1) {
              signal = options?.signal;
              called.resolve();
              if (failure === "timeout") return new Promise(() => {});
              throw new Error("MCP status unavailable");
            }
            return { data: { weather: { status: "connected" } } };
          },
        },
      });
      yield* harness.startTurn();
      const received = yield* harness.runtime.events.pipe(
        Stream.takeUntil(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
        ),
        Stream.runCollect,
        Effect.forkScoped,
      );
      for (const status of ["running", "completed"] as const) {
        const emitted = yield* Effect.promise(() =>
          nativeEvents.push({
            type: "message.part.updated",
            properties: {
              sessionID: sessionId,
              part: {
                id: "weather-part",
                sessionID: sessionId,
                messageID: "weather-message",
                type: "tool",
                callID: "weather-call",
                tool: "weather_edit_document",
                state: {
                  status,
                  input: { document: "remote-doc" },
                  title: "Edit remote document",
                  metadata: {},
                  output: "saved",
                  time: { start: 1, end: 2 },
                },
              },
            },
          }),
        ).pipe(Effect.forkScoped);
        if (status === "running" && failure === "timeout") {
          yield* Effect.promise(() => called.promise);
          yield* TestClock.adjust("1 second");
        }
        yield* Fiber.join(emitted);
      }
      yield* Effect.promise(() =>
        nativeEvents.push({ type: "session.compacted", properties: { sessionID: sessionId } }),
      );
      const completed = (yield* Fiber.join(received)).find(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.status === "completed",
      );
      assert.equal(statusReads, 2);
      assert.equal(
        completed?.type === "turn_item.updated" && completed.turnItem.title,
        "Edit remote document",
      );
      assert.deepEqual(completed?.type === "turn_item.updated" && completed.turnItem.toolSource, {
        key: "mcp:weather",
        name: "weather",
        kind: "integration",
      });
      if (failure === "timeout") assert.isTrue(signal?.aborted);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("sends unadvertised slash commands as ordinary prompts", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const prompts: unknown[] = [];
      const harness = yield* makeOpenCodeRuntimeHarness("unknown-command", "unknown-command", {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        command: { list: async () => ({ data: [{ name: "review" }] }) },
        session: {
          create: async () => ({
            data: { id: "unknown-command", time: { created: 1, updated: 1 } },
          }),
          promptAsync: async (input: { parts: unknown }) => {
            prompts.push(input.parts);
            return { data: true };
          },
        },
      });
      yield* harness.startTurn("/unknown words");
      assert.deepEqual(prompts, [[{ type: "text", text: "/unknown words" }]]);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("keeps a newly admitted prompt alive across stale idle and delayed busy evidence", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const prompt = promiseGate<void>();
      const promptStarted = promiseGate<void>();
      const steerPrompt = promiseGate<void>();
      const steerPromptStarted = promiseGate<void>();
      const stopPromptStarted = promiseGate<void>();
      const statusCalled = promiseGate<void>();
      const steerStatusCalled = promiseGate<void>();
      const abortCalled = promiseGate<void>();
      let status: "idle" | "busy" = "busy";
      let promptCalls = 0;
      let statusCalls = 0;
      const promptInputs: Array<{ readonly messageID?: string }> = [];
      const client = {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        session: {
          create: async () => ({
            data: { id: "native-opencode-race", time: { created: 1, updated: 1 } },
          }),
          get: async () => ({
            data: { id: "native-opencode-race", time: { created: 1, updated: 1 } },
          }),
          promptAsync: async (
            input: { readonly messageID?: string },
            options?: { readonly signal?: AbortSignal },
          ) => {
            promptInputs.push(input);
            promptCalls += 1;
            if (promptCalls === 1) {
              promptStarted.resolve();
              await prompt.promise;
            } else if (promptCalls === 2) {
              steerPromptStarted.resolve();
              await steerPrompt.promise;
            } else {
              stopPromptStarted.resolve();
              await new Promise<void>((_resolve, reject) =>
                options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), {
                  once: true,
                }),
              );
            }
            return { data: true };
          },
          status: async () => ({
            data: (() => {
              statusCalls += 1;
              if (statusCalls === 1) statusCalled.resolve();
              else steerStatusCalled.resolve();
              return { "native-opencode-race": { type: status } };
            })(),
          }),
          messages: async () => ({ data: [] }),
          children: async () => ({ data: [] }),
          abort: async () => {
            abortCalled.resolve();
            return { data: true };
          },
        },
        mcp: { add: async () => ({ data: true }) },
      };
      const adapter = yield* makeOpenCodeAdapterV2({
        instanceId: ProviderInstanceId.make("opencode-test"),
        settings: OPEN_CODE_TEST_SETTINGS,
        environment: {},
      }).pipe(
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, {
          connectToOpenCodeServer: () =>
            Effect.succeed({ url: "http://test.invalid", external: true }),
          createOpenCodeSdkClient: () => client,
        } as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"]),
        Effect.provideService(ProviderHost.ProviderHost, {
          paths: { cwd: "/workspace" },
          settings: { get: Effect.succeed({ globalCustomInstructions: "" }) },
          resolveAttachmentPath: () => null,
        } as unknown as ProviderHost.ProviderHost["Service"]),
      );
      const threadId = ThreadId.make("thread-opencode-admission-race");
      const providerSessionId = ProviderSessionId.make("session-opencode-admission-race");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("opencode-test"),
        model: "anthropic/claude-sonnet",
        options: [],
      };
      const policy = runtimePolicy("full-access", { cwd: "/workspace" });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy: policy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: policy,
      });
      const now = yield* DateTime.now;
      const attemptId = RunAttemptId.make("attempt-opencode-admission-race");
      const runId = RunId.make("run-opencode-admission-race");
      const start = yield* runtime
        .startTurn({
          appThread: {
            id: threadId,
            projectId: ProjectId.make("project-opencode-admission-race"),
            title: "race",
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdBy: "user",
            creationSource: "web",
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId,
          rootNodeId: NodeId.make("node-opencode-admission-race"),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-opencode-admission-race"),
            text: "hello",
            attachments: [],
          },
          modelSelection,
          runtimePolicy: policy,
        })
        .pipe(Effect.forkScoped);

      yield* Effect.promise(() => promptStarted.promise);
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: { sessionID: "native-opencode-race", status: { type: "idle" } },
        }),
      );
      prompt.resolve();
      yield* Fiber.join(start);
      assert.match(promptInputs[0]?.messageID ?? "", /^msg_[0-9a-f]{12}[0-9A-Za-z]{28}$/);
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: { sessionID: "native-opencode-race", status: { type: "busy" } },
        }),
      );
      status = "busy";
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "message.updated",
          properties: {
            sessionID: "native-opencode-race",
            info: {
              id: "stale-user-message",
              sessionID: "native-opencode-race",
              role: "user",
              time: { created: DateTime.toEpochMillis(now) },
            },
          },
        }),
      );
      assert.equal(statusCalls, 0, "an unrelated user message must not release prompt admission");
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: { sessionID: "native-opencode-race", status: { type: "idle" } },
        }),
      );
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "message.updated",
          properties: {
            sessionID: "native-opencode-race",
            info: {
              id: promptInputs[0]!.messageID!,
              sessionID: "native-opencode-race",
              role: "user",
              time: { created: DateTime.toEpochMillis(now) },
            },
          },
        }),
      );

      yield* Effect.promise(() => statusCalled.promise);

      const snapshot = yield* runtime.readThreadSnapshot({ providerThread });
      assert.equal(snapshot.providerTurns.at(-1)?.status, "running");
      const activeTurn = snapshot.providerTurns.at(-1)!;
      const steer = yield* runtime
        .steerTurn({
          threadId,
          runId,
          providerThread,
          providerTurnId: activeTurn.id,
          message: {
            messageId: MessageId.make("message-opencode-steer-race"),
            text: "follow up",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => steerPromptStarted.promise);
      assert.notEqual(promptInputs[1]?.messageID, promptInputs[0]?.messageID);
      steerPrompt.resolve();
      yield* Fiber.join(steer);
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: { sessionID: "native-opencode-race", status: { type: "busy" } },
        }),
      );
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "message.updated",
          properties: {
            sessionID: "native-opencode-race",
            info: {
              id: promptInputs[0]!.messageID!,
              sessionID: "native-opencode-race",
              role: "user",
              time: { created: DateTime.toEpochMillis(now) },
            },
          },
        }),
      );
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: { sessionID: "native-opencode-race", status: { type: "idle" } },
        }),
      );
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "message.updated",
          properties: {
            sessionID: "native-opencode-race",
            info: {
              id: promptInputs[1]!.messageID!,
              sessionID: "native-opencode-race",
              role: "user",
              time: { created: DateTime.toEpochMillis(now) },
            },
          },
        }),
      );
      yield* Effect.promise(() => steerStatusCalled.promise);
      const pendingSteer = yield* runtime
        .steerTurn({
          threadId,
          runId,
          providerThread,
          providerTurnId: activeTurn.id,
          message: {
            messageId: MessageId.make("message-opencode-stop-pending"),
            text: "pending when stopped",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Effect.promise(() => stopPromptStarted.promise);
      const interrupt = yield* runtime
        .interruptTurn({ providerThread, providerTurnId: activeTurn.id })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => abortCalled.promise);
      yield* Fiber.join(interrupt);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(pendingSteer)));
      const promptWhileStopping = yield* Effect.exit(
        runtime.steerTurn({
          threadId,
          runId,
          providerThread,
          providerTurnId: activeTurn.id,
          message: {
            messageId: MessageId.make("message-opencode-after-stop"),
            text: "must not pass the pending stop",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        }),
      );
      assert.isTrue(Exit.isFailure(promptWhileStopping));
      assert.equal(promptCalls, 3);
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: { sessionID: "native-opencode-race", status: { type: "idle" } },
        }),
      );
      const interrupted = yield* runtime.readThreadSnapshot({ providerThread });
      assert.equal(interrupted.providerTurns.at(-1)?.status, "interrupted");
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("interrupts an initial prompt while its SDK request is pending", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const promptStarted = promiseGate<void>();
      const abortCalled = promiseGate<void>();
      let abortCalls = 0;
      const client = {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        session: {
          create: async () => ({
            data: { id: "native-opencode-initial-stop", time: { created: 1, updated: 1 } },
          }),
          get: async () => ({
            data: { id: "native-opencode-initial-stop", time: { created: 1, updated: 1 } },
          }),
          promptAsync: async (_input: unknown, options?: { readonly signal?: AbortSignal }) => {
            promptStarted.resolve();
            await new Promise<void>((_resolve, reject) => {
              const signal = options?.signal;
              if (signal?.aborted) {
                reject(signal.reason);
                return;
              }
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
            return { data: true };
          },
          status: async () => ({
            data: { "native-opencode-initial-stop": { type: "idle" as const } },
          }),
          messages: async () => ({ data: [] }),
          children: async () => ({ data: [] }),
          abort: async () => {
            abortCalls += 1;
            abortCalled.resolve();
            return { data: true };
          },
        },
        mcp: { add: async () => ({ data: true }) },
      };
      const adapter = yield* makeOpenCodeAdapterV2({
        instanceId: ProviderInstanceId.make("opencode-initial-stop-test"),
        settings: OPEN_CODE_TEST_SETTINGS,
        environment: {},
      }).pipe(
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, {
          connectToOpenCodeServer: () =>
            Effect.succeed({ url: "http://test.invalid", external: true }),
          createOpenCodeSdkClient: () => client,
        } as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"]),
        Effect.provideService(ProviderHost.ProviderHost, {
          paths: { cwd: "/workspace" },
          settings: { get: Effect.succeed({ globalCustomInstructions: "" }) },
          resolveAttachmentPath: () => null,
        } as unknown as ProviderHost.ProviderHost["Service"]),
      );
      const threadId = ThreadId.make("thread-opencode-initial-stop");
      const providerSessionId = ProviderSessionId.make("session-opencode-initial-stop");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("opencode-initial-stop-test"),
        model: "anthropic/claude-sonnet",
        options: [],
      };
      const policy = runtimePolicy("full-access", { cwd: "/workspace" });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy: policy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: policy,
      });
      const terminalEvents = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const now = yield* DateTime.now;
      const start = yield* runtime
        .startTurn({
          appThread: {
            id: threadId,
            projectId: ProjectId.make("project-opencode-initial-stop"),
            title: "initial stop",
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdBy: "user",
            creationSource: "web",
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId: RunId.make("run-opencode-initial-stop"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("attempt-opencode-initial-stop"),
          rootNodeId: NodeId.make("node-opencode-initial-stop"),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-opencode-initial-stop"),
            text: "hello",
            attachments: [],
          },
          modelSelection,
          runtimePolicy: policy,
        })
        .pipe(Effect.forkScoped);

      yield* Effect.promise(() => promptStarted.promise);
      const running = yield* runtime.readThreadSnapshot({ providerThread });
      const activeTurn = running.providerTurns.at(-1)!;
      const interrupt = yield* runtime
        .interruptTurn({ providerThread, providerTurnId: activeTurn.id })
        .pipe(Effect.forkScoped);

      yield* Effect.promise(() => abortCalled.promise);
      yield* Fiber.join(start);
      yield* Fiber.join(interrupt);
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: {
            sessionID: "native-opencode-initial-stop",
            status: { type: "idle" },
          },
        }),
      );

      const events = Array.from(yield* Fiber.join(terminalEvents));
      const terminals = events.filter((event) => event.type === "turn.terminal");
      assert.equal(abortCalls, 1);
      assert.lengthOf(terminals, 1);
      assert.equal(terminals[0]?.status, "interrupted");
      assert.isNull(terminals[0]?.failure ?? null);
      assert.isFalse(
        events.some(
          (event) =>
            (event.type === "turn.terminal" && event.status === "failed") ||
            (event.type === "provider_session.updated" && event.providerSession.status === "error"),
        ),
      );
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it("releases admission only after prompt acceptance and new-turn evidence", () => {
    const admission = {
      admissionPending: true,
      admissionAccepted: false,
      admissionMessageObserved: false,
      idleDuringAdmission: false,
    };

    assert.equal(advanceOpenCodePromptAdmission(admission, "busy"), "hold");
    assert.equal(advanceOpenCodePromptAdmission(admission, "accepted"), "release");
    assert.isFalse(admission.admissionPending);
  });

  it.effect("reconciles current idle and busy status replies after prompt admission", () =>
    Effect.gen(function* () {
      for (const expected of ["idle", "busy"] as const) {
        const admission = { admissionGeneration: 4, admissionPending: true };
        const status = yield* Deferred.make<"idle" | "busy" | "unknown">();
        const fiber = yield* reconcileOpenCodePromptAdmissionStatus(
          admission,
          4,
          Deferred.await(status),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        yield* Deferred.succeed(status, expected);

        assert.equal(yield* Fiber.join(fiber), expected);
        assert.isFalse(admission.admissionPending);
      }
    }),
  );

  it.effect("retries a transient status failure without another idle event", () =>
    Effect.gen(function* () {
      const nativeSessionId = "native-opencode-status-retry";
      const nativeEvents = asyncEventStream();
      const promptRelease = promiseGate<void>();
      const promptCalls = yield* Queue.unbounded<string>();
      const statusCalls = yield* Queue.unbounded<number>();
      let statusCallCount = 0;
      const client = {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        session: {
          create: async () => ({
            data: { id: nativeSessionId, time: { created: 1, updated: 1 } },
          }),
          get: async () => ({
            data: { id: nativeSessionId, time: { created: 1, updated: 1 } },
          }),
          promptAsync: async (input: { readonly messageID?: string }) => {
            Queue.offerUnsafe(promptCalls, input.messageID!);
            await promptRelease.promise;
            return { data: true };
          },
          status: async () => {
            statusCallCount += 1;
            Queue.offerUnsafe(statusCalls, statusCallCount);
            if (statusCallCount === 1) throw new Error("transient status failure");
            return { data: { [nativeSessionId]: { type: "idle" as const } } };
          },
          messages: async () => ({ data: [] }),
          children: async () => ({ data: [] }),
          abort: async () => ({ data: true }),
        },
        mcp: { add: async () => ({ data: true }) },
      };
      const harness = yield* makeOpenCodeRuntimeHarness("status-retry", nativeSessionId, client);
      const terminalEvents = yield* harness.runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const start = yield* harness.startTurn().pipe(Effect.forkScoped);
      const admissionMessageId = yield* Queue.take(promptCalls);

      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: { sessionID: nativeSessionId, status: { type: "idle" } },
        }),
      );
      promptRelease.resolve();
      yield* Fiber.join(start);
      const userMessage = {
        type: "message.updated",
        properties: {
          sessionID: nativeSessionId,
          info: {
            id: admissionMessageId,
            sessionID: nativeSessionId,
            role: "user",
            time: { created: DateTime.toEpochMillis(harness.now) },
          },
        },
      };
      yield* Effect.promise(() => nativeEvents.push(userMessage));
      assert.equal(yield* Queue.take(statusCalls), 1);

      yield* Effect.promise(() => nativeEvents.push(userMessage));
      assert.equal(statusCallCount, 1, "duplicate events must share the generation's retry worker");
      yield* TestClock.adjust("250 millis");
      assert.equal(yield* Queue.take(statusCalls), 2);

      const events = Array.from(yield* Fiber.join(terminalEvents));
      const terminals = events.filter((event) => event.type === "turn.terminal");
      assert.equal(statusCallCount, 2);
      assert.lengthOf(terminals, 1);
      assert.equal(terminals[0]?.status, "completed");
      assert.isNull(terminals[0]?.failure ?? null);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("does not let a queued status retry adopt a newer steer generation", () =>
    Effect.gen(function* () {
      const nativeSessionId = "native-opencode-stale-status-retry";
      const nativeEvents = asyncEventStream();
      const firstPromptRelease = promiseGate<void>();
      const promptCalls = yield* Queue.unbounded<string>();
      const statusCalls = yield* Queue.unbounded<number>();
      let promptCallCount = 0;
      let statusCallCount = 0;
      const client = {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        session: {
          create: async () => ({
            data: { id: nativeSessionId, time: { created: 1, updated: 1 } },
          }),
          get: async () => ({
            data: { id: nativeSessionId, time: { created: 1, updated: 1 } },
          }),
          promptAsync: async (input: { readonly messageID?: string }) => {
            promptCallCount += 1;
            Queue.offerUnsafe(promptCalls, input.messageID!);
            if (promptCallCount === 1) {
              await firstPromptRelease.promise;
            }
            return { data: true };
          },
          status: async () => {
            statusCallCount += 1;
            Queue.offerUnsafe(statusCalls, statusCallCount);
            if (statusCallCount === 1) throw new Error("transient status failure");
            return { data: { [nativeSessionId]: { type: "idle" as const } } };
          },
          messages: async () => ({ data: [] }),
          children: async () => ({ data: [] }),
          abort: async () => ({ data: true }),
        },
        mcp: { add: async () => ({ data: true }) },
      };
      const harness = yield* makeOpenCodeRuntimeHarness(
        "stale-status-retry",
        nativeSessionId,
        client,
      );
      const start = yield* harness.startTurn().pipe(Effect.forkScoped);
      const firstAdmissionMessageId = yield* Queue.take(promptCalls);

      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: { sessionID: nativeSessionId, status: { type: "idle" } },
        }),
      );
      firstPromptRelease.resolve();
      yield* Fiber.join(start);
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "message.updated",
          properties: {
            sessionID: nativeSessionId,
            info: {
              id: firstAdmissionMessageId,
              sessionID: nativeSessionId,
              role: "user",
              time: { created: DateTime.toEpochMillis(harness.now) },
            },
          },
        }),
      );
      assert.equal(yield* Queue.take(statusCalls), 1);

      const running = yield* harness.runtime.readThreadSnapshot({
        providerThread: harness.providerThread,
      });
      const activeTurn = running.providerTurns.at(-1)!;
      yield* harness.runtime.steerTurn({
        threadId: harness.threadId,
        runId: harness.runId,
        providerThread: harness.providerThread,
        providerTurnId: activeTurn.id,
        message: {
          messageId: MessageId.make("message-opencode-stale-status-retry-steer"),
          text: "new generation",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      yield* Queue.take(promptCalls);
      yield* TestClock.adjust("250 millis");

      const afterRetry = yield* harness.runtime.readThreadSnapshot({
        providerThread: harness.providerThread,
      });
      assert.equal(statusCallCount, 1);
      assert.equal(afterRetry.providerTurns.at(-1)?.status, "running");
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );

  it.effect("does not revive admission when abort wins a pending status lookup", () =>
    Effect.gen(function* () {
      const admission = { admissionGeneration: 4, admissionPending: true };
      const status = yield* Deferred.make<"idle" | "busy" | "unknown">();
      const fiber = yield* reconcileOpenCodePromptAdmissionStatus(
        admission,
        4,
        Deferred.await(status),
      ).pipe(Effect.forkChild({ startImmediately: true }));

      cancelOpenCodePromptAdmission(admission, 5);
      yield* Deferred.succeed(status, "idle");

      assert.equal(yield* Fiber.join(fiber), "stale");
      assert.isFalse(admission.admissionPending);
    }),
  );

  it.effect("logs bounded structural protocol diagnostics without native payload values", () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const records: Array<unknown> = [];
      const nativeEventLogger: ProviderEventLoggers.EventNdjsonLogger = {
        filePath: "/tmp/provider-native.ndjson",
        write: (event) =>
          Effect.sync(() => {
            records.push(event);
            return {
              _tag: "Accepted" as const,
              pendingRecords: 0,
              pendingBytes: 0,
              lossCounts: { lowValue: 0, protected: 0 },
            };
          }),
        close: () => Effect.void,
      };
      const logProtocolEvent = makeOpenCodeProtocolLogger({
        nativeEventLogger,
        idAllocator,
        providerInstanceId: ProviderInstanceId.make("opencode-test"),
        providerSessionId: ProviderSessionId.make("provider-session-opencode-test"),
        threadId: ThreadId.make("thread-opencode-test"),
      });
      const secret = "secret-opencode-prompt";

      yield* logProtocolEvent({
        direction: "outgoing",
        messageKind: "request",
        method: "session.prompt",
        payload: { prompt: secret, nested: { token: secret } },
      });

      const serialized = encodeUnknownJson(records);
      assert.notInclude(serialized, secret);
      assert.include(serialized, '"protocol":"opencode-sdk.sse"');
      assert.include(serialized, '"method":"session.prompt"');
      assert.include(serialized, '"fieldCount":2');
    }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer))),
  );

  it.effect("adopts the handed-over provider thread identity on session create", () =>
    Effect.gen(function* () {
      let createCount = 0;
      const createInputs: Array<unknown> = [];
      const fakeClient = {
        event: {
          subscribe: async (_input?: unknown, options?: { readonly signal?: AbortSignal }) => ({
            stream: {
              [Symbol.asyncIterator]: () => ({
                next: () =>
                  new Promise<IteratorResult<never>>((resolve) => {
                    const done = () => resolve({ done: true, value: undefined });
                    if (options?.signal?.aborted) return done();
                    options?.signal?.addEventListener("abort", done, { once: true });
                  }),
              }),
            },
          }),
        },
        session: {
          create: async (input: unknown) => {
            createCount += 1;
            createInputs.push(input);
            return { data: { id: `ses_native_${createCount}`, time: { created: 1, updated: 1 } } };
          },
        },
      } as unknown as OpencodeClient;
      const unused = (operation: string) => () => Effect.die(`${operation} is not used`);
      const runtime: OpenCodeRuntime.OpenCodeRuntime["Service"] = {
        startOpenCodeServerProcess: unused("startOpenCodeServerProcess"),
        connectToOpenCodeServer: () =>
          Effect.succeed({
            url: "test://opencode",
            version: "test",
            exitCode: null,
            external: true,
          }),
        runOpenCodeCommand: unused("runOpenCodeCommand"),
        createOpenCodeSdkClient: () => fakeClient,
        loadOpenCodeInventory: unused("loadOpenCodeInventory"),
        loadInventoryFromCli: unused("loadInventoryFromCli"),
        loadOpenCodeSkills: unused("loadOpenCodeSkills"),
        loadSkillsFromCli: unused("loadSkillsFromCli"),
      };
      const instanceId = ProviderInstanceId.make("opencode");
      const threadId = ThreadId.make("thread-opencode-adopt");
      const modelSelection = { instanceId, model: "default" };
      const adapter = yield* makeOpenCodeAdapterV2({
        instanceId,
        settings: OPENCODE_TEST_SETTINGS,
        environment: {},
      }).pipe(Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime));
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-opencode-adopt"),
        modelSelection,
        runtimePolicy: runtimePolicy("full-access"),
      });
      const now = yield* DateTime.now;
      const placeholder: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make("thread:provider:opencode:native-thread:pending:run:adopt:1"),
        driver: OPENCODE_PROVIDER,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const adopted = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: runtimePolicy("full-access"),
        existingProviderThread: placeholder,
      });
      assert.equal(adopted.id, placeholder.id);
      assert.equal(adopted.nativeThreadRef?.nativeId, "ses_native_1");
      const minted = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: runtimePolicy("full-access"),
      });
      assert.notEqual(minted.id, placeholder.id);
      assert.equal(minted.nativeThreadRef?.nativeId, "ses_native_2");
      // OpenCode names a session from its first prompt only when create
      // leaves the title unset, so the adapter never sends one.
      for (const input of createInputs) {
        assert.notProperty(input, "title");
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    ),
  );

  it("maps native permission families to orchestration request kinds", () => {
    assert.equal(openCodePermissionRequestKind("bash"), "command");
    assert.equal(openCodePermissionRequestKind("read"), "file-read");
    assert.equal(openCodePermissionRequestKind("grep"), "file-read");
    assert.equal(openCodePermissionRequestKind("external_directory"), "file-read");
    assert.equal(openCodePermissionRequestKind("external_directory", "edit"), "file-change");
    assert.equal(openCodePermissionRequestKind("edit"), "file-change");
    assert.equal(openCodePermissionRequestKind("apply_patch"), "file-change");
    assert.equal(openCodePermissionRequestKind("todowrite"), "command");
    assert.equal(openCodePermissionRequestKind("custom", "todowrite"), "command");
  });

  it("maps OpenCode tools to semantic turn-item families", () => {
    assert.equal(openCodeToolProjectionKind("bash"), "command_execution");
    assert.equal(openCodeToolProjectionKind("edit"), "file_change");
    assert.equal(openCodeToolProjectionKind("read"), "dynamic_tool");
    assert.equal(openCodeToolProjectionKind("lsp"), "file_search");
    assert.equal(openCodeToolProjectionKind("websearch"), "web_search");
    assert.equal(openCodeToolProjectionKind("codesearch"), "web_search");
    assert.equal(openCodeToolProjectionKind("todowrite"), "dynamic_tool");
    assert.equal(openCodeToolProjectionKind("custom_tool"), "dynamic_tool");
  });
});
