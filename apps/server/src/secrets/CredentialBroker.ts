import {
  Arguments as HostProcessArguments,
  IsExecutable as HostProcessIsExecutable,
  ExecutablePath as HostProcessExecutablePath,
} from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Option from "effect/Option";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { loadCaller, unavailable } from "../mcp/threadAccess.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { executeManualCredential } from "@t3tools/credential-broker/manual";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import { T3CredentialBroker } from "@t3tools/credential-broker";
import {
  CredentialBrokerError,
  CredentialBrokerFailureCode,
  OrchestratorMcpFailure,
  type CredentialBrowserLoginInput,
  type CredentialBrokerAction,
  type CredentialBrokerState,
  type CredentialCaller,
  type CredentialExecInput,
  type CredentialExecution,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";

export class CredentialBroker extends Context.Service<
  CredentialBroker,
  {
    readonly execute: (
      caller: CredentialCaller,
      input: CredentialExecInput,
    ) => Effect.Effect<CredentialExecution, CredentialBrokerError>;
    readonly executeFromTool: (
      input: CredentialExecInput,
    ) => Effect.Effect<
      CredentialExecution,
      OrchestratorMcpFailure,
      | McpInvocationContext.McpInvocationContext
      | ProjectService.ProjectService
      | ThreadManagement.ThreadManagementService
      | Crypto.Crypto
    >;
    readonly browserLoginFromTool: (
      input: CredentialBrowserLoginInput,
    ) => Effect.Effect<
      CredentialExecution,
      OrchestratorMcpFailure,
      | McpInvocationContext.McpInvocationContext
      | ProjectService.ProjectService
      | ThreadManagement.ThreadManagementService
      | Crypto.Crypto
    >;
    readonly action: (
      sessionId: string,
      input: CredentialBrokerAction,
    ) => Effect.Effect<void, CredentialBrokerError>;
    readonly subscribe: (
      sessionId: string,
      viewId: string,
    ) => Stream.Stream<CredentialBrokerState, CredentialBrokerError>;
  }
>()("t3/secrets/CredentialBroker") {}

/** Only stable broker codes cross the boundary; never copy provider error text. */
const isBrokerFailureCode = Schema.is(CredentialBrokerFailureCode);
export function safeBrokerFailure(error: unknown) {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return new CredentialBrokerError({
    code: isBrokerFailureCode(code) ? code : "broker_unavailable",
  });
}
const toolBrokerFailure = (error: CredentialBrokerError) =>
  new OrchestratorMcpFailure({ code: "credential_broker_error", message: error.message });

/** Bind one authenticated tool invocation to its thread and committed lifetime. */
export const bindToolCall = (
  input: CredentialExecInput,
  execute: (
    caller: CredentialCaller,
    input: CredentialExecInput,
  ) => Effect.Effect<CredentialExecution, CredentialBrokerError>,
) =>
  Effect.gen(function* () {
    const context = yield* loadCaller();
    const { thread } = yield* McpInvocationContext.requireThreadScope(
      context.scope,
      "Credential Broker",
    );
    const caller = context.caller;
    if (!caller || !caller.activeRunId) return yield* unavailable();
    const projects = yield* ProjectService.ProjectService;
    const project = yield* projects.getShell(caller.projectId).pipe(Effect.mapError(unavailable));
    if (Option.isNone(project)) return yield* unavailable();
    const crypto = yield* Crypto.Crypto;

    // The UUID names this exact handler invocation and its cancellable fiber.
    // Thread/session/run/workspace come from authenticated server state, never shell labels.
    const toolCallId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const sequence = yield* context.threads
      .getThreadEventSequence(thread.threadId)
      .pipe(Effect.mapError(unavailable));
    const current = yield* context.threads
      .getThreadShell(thread.threadId)
      .pipe(Effect.mapError(unavailable));
    if (
      !current ||
      current.activeRunId !== caller.activeRunId ||
      current.providerInstanceId !== thread.providerInstanceId
    )
      return yield* unavailable();
    const stopped = context.threads
      .streamStoredEventsFrom({ threadId: thread.threadId, afterSequence: sequence })
      .pipe(
        Stream.filter(
          ({ event }) =>
            (event.type === "run.updated" &&
              event.payload.id === caller.activeRunId &&
              ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
                event.payload.status,
              )) ||
            ["thread.archived", "thread.deleted", "thread.provider-switched"].includes(event.type),
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.mapError(unavailable),
        Effect.andThen(
          Effect.fail(toolBrokerFailure(new CredentialBrokerError({ code: "caller_cancelled" }))),
        ),
      );
    return yield* execute(
      {
        environmentId: context.scope.environmentId,
        ...thread,
        threadTitle: caller.title,
        projectId: caller.projectId,
        projectName: project.value.title,
        runId: caller.activeRunId,
        toolCallId,
        workspace: caller.worktreePath ?? project.value.workspaceRoot,
        agent: caller.modelSelection.model,
      },
      input,
    ).pipe(Effect.mapError(toolBrokerFailure), Effect.raceFirst(stopped));
  });

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const browser = yield* ServerBrowser.ServerBrowser;
  const executablePath = yield* HostProcessExecutablePath;
  const argv = yield* HostProcessArguments;
  const executable = yield* HostProcessIsExecutable;
  const workerEntrypoint = executable
    ? ["__credential-broker-worker"]
    : [argv[1]!, "__credential-broker-worker"];
  // This adapter is the sole Promise boundary for the reused standalone broker.
  const broker = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new T3CredentialBroker({
          runtime: path.join(config.stateDir, "credential-broker"),
          workerEntrypoint,
        }),
    ),
    (broker) => Effect.promise(() => broker.close()).pipe(Effect.ignore),
  );
  if (registry.onRevoke) {
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        registry.onRevoke!((id) =>
          Effect.promise(() => broker.cancelSession(id)).pipe(Effect.ignore),
        ),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );
  }
  const execute = (caller: CredentialCaller, input: CredentialExecInput) =>
    Effect.tryPromise({
      try: (signal) => broker.execute(caller, input, signal),
      catch: safeBrokerFailure,
    }).pipe(
      Effect.ensuring(
        Effect.promise(() => broker.cancelCall(caller.toolCallId)).pipe(Effect.ignore),
      ),
    );
  const browserInput = (
    target: { site: string; origin: string; profile: string },
    fields: CredentialBrowserLoginInput,
    cwd: string,
  ): CredentialExecInput => ({
    site: target.site,
    field: "login",
    label: "Sign in through the integrated T3 browser",
    reason: fields.reason,
    ttlSeconds: 60,
    cwd,
    argv: [
      executablePath,
      ...workerEntrypoint,
      "browser",
      target.origin,
      target.profile,
      fields.usernameSelector,
      fields.passwordSelector,
      fields.submitSelector,
      ...(fields.usernameSubmitSelector ? [fields.usernameSubmitSelector] : []),
    ],
  });
  const browserCalls = new Map<
    string,
    {
      caller: CredentialCaller;
      input: CredentialExecInput;
      endpoint: string;
      browser: { tabId: string; origin: string; profile: string };
      manualResult: CredentialExecution | undefined;
      manualPending: boolean;
    }
  >();
  const runBrowser = (caller: CredentialCaller, fields: CredentialBrowserLoginInput) =>
    Effect.scoped(
      Effect.gen(function* () {
        const target = yield* browser.prepareCredentialLogin({
          ...fields,
          threadId: caller.threadId,
          agentSessionId: `${caller.environmentId}\u0000${caller.providerSessionId}`,
        });
        const input = browserInput(target, fields, caller.workspace);
        const call = {
          caller,
          input,
          endpoint: target.endpoint,
          browser: { tabId: fields.tabId, origin: target.origin, profile: target.profile },
          manualPending: false,
          manualResult: undefined as CredentialExecution | undefined,
        };
        browserCalls.set(caller.toolCallId, call);
        return yield* Effect.tryPromise({
          try: async (signal) => {
            const result = await broker.execute(caller, input, signal, {
              CB_BROWSER_ENDPOINT: target.endpoint,
            });
            return call.manualResult ?? result;
          },
          catch: safeBrokerFailure,
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              browserCalls.delete(caller.toolCallId);
              yield* Effect.promise(() => broker.cancelCall(caller.toolCallId)).pipe(Effect.ignore);
            }),
          ),
        );
      }),
    );
  const manualForRequest = (input: Extract<CredentialBrokerAction, { type: "browserManual" }>) =>
    Effect.gen(function* () {
      const request = broker
        .state()
        .requests.find((request) => request.requestId === input.requestId);
      const call = request?.origin ? browserCalls.get(request.origin.toolCallId) : undefined;
      if (!call || call.manualPending || !["pending", "awaiting_unlock"].includes(request!.state))
        return yield* new CredentialBrokerError({ code: "invalid_request" });
      call.manualPending = true;
      yield* Effect.tryPromise({
        try: async (signal) => {
          const result = await executeManualCredential({
            runtime: path.join(config.stateDir, "credential-broker"),
            workerEntrypoint,
            origin: call.caller,
            input: call.input,
            login: { username: input.username, password: input.password },
            consumerEnvironment: { CB_BROWSER_ENDPOINT: call.endpoint },
            signal,
          });
          call.manualResult = result;
          await broker.cancelCall(call.caller.toolCallId);
          if (result.state !== "completed" || result.exitCode !== 0) throw new Error();
        },
        catch: safeBrokerFailure,
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            call.manualPending = false;
          }),
        ),
      );
    });
  return CredentialBroker.of({
    execute,
    executeFromTool: (input) => bindToolCall(input, execute),
    browserLoginFromTool: (fields) =>
      McpInvocationContext.requireThreadMcpCapability("preview").pipe(
        Effect.mapError(unavailable),
        Effect.andThen(
          bindToolCall(
            {
              site: "browser-target.invalid",
              field: "login",
              label: "Browser sign-in",
              reason: fields.reason,
              ttlSeconds: 60,
              argv: [],
            },
            (caller) => runBrowser(caller, fields),
          ),
        ),
      ),
    action: (sessionId, input) =>
      input.type === "browserManual"
        ? manualForRequest(input)
        : Effect.tryPromise({
            try: () => {
              if (input.type === "decide" && input.decision !== "deny") {
                const request = broker
                  .state()
                  .requests.find((request) => request.requestId === input.requestId);
                if (request?.origin && browserCalls.get(request.origin.toolCallId)?.manualPending)
                  throw new Error("Manual sign-in is already running.");
              }
              return broker.action(sessionId, input);
            },
            catch: () => new CredentialBrokerError({}),
          }),
    subscribe: (sessionId, viewId) =>
      Stream.callback<CredentialBrokerState, CredentialBrokerError>(
        (queue) =>
          Effect.acquireRelease(
            Effect.try({
              try: () =>
                broker.subscribe(sessionId, viewId, (state) => {
                  Queue.offerUnsafe(queue, {
                    ...state,
                    requests: state.requests.map((request) => {
                      const call = request.origin
                        ? browserCalls.get(request.origin.toolCallId)
                        : undefined;
                      return call ? { ...request, browser: call.browser } : request;
                    }),
                  });
                }),
              catch: () => new CredentialBrokerError({}),
            }),
            (unsubscribe) => Effect.sync(unsubscribe),
          ),
        { bufferSize: 1, strategy: "sliding" },
      ),
  });
});
export const layer = Layer.effect(CredentialBroker, make);
