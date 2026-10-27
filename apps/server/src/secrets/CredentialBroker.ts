import {
  Arguments as HostProcessArguments,
  IsExecutable as HostProcessIsExecutable,
} from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Option from "effect/Option";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { loadCaller, unavailable } from "../mcp/threadAccess.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import { T3CredentialBroker } from "@t3tools/credential-broker";
import {
  CredentialBrokerError,
  CredentialBrokerFailureCode,
  OrchestratorMcpFailure,
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
  const browser = yield* ServerBrowser.ServerBrowser;
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const argv = yield* HostProcessArguments;
  const executable = yield* HostProcessIsExecutable;
  const workerEntrypoint = executable
    ? ["__credential-broker-worker"]
    : [argv[1]!, "__credential-broker-worker"];
  // This adapter owns the Promise boundary to the credential broker.
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
    Effect.scoped(
      Effect.gen(function* () {
        const bridge =
          input.browserTabId === undefined
            ? undefined
            : yield* browser.scriptBridge({
                threadId: caller.threadId,
                tabId: input.browserTabId,
                site: input.site,
                agentSessionId: `${caller.environmentId}\u0000${caller.providerSessionId}`,
              });
        return yield* Effect.tryPromise({
          try: (signal) =>
            broker.execute(
              caller,
              input,
              signal,
              bridge ? { T3_BROWSER_URL: bridge.endpoint } : undefined,
            ),
          catch: safeBrokerFailure,
        }).pipe(
          Effect.ensuring(
            Effect.promise(() => broker.cancelCall(caller.toolCallId)).pipe(Effect.ignore),
          ),
        );
      }),
    );
  return CredentialBroker.of({
    execute,
    executeFromTool: (input) =>
      (input.browserTabId === undefined
        ? Effect.void
        : McpInvocationContext.requireThreadMcpCapability("preview").pipe(
            Effect.mapError(unavailable),
          )
      ).pipe(Effect.andThen(bindToolCall(input, execute))),
    action: (sessionId, input) =>
      Effect.tryPromise({
        try: () => broker.action(sessionId, input),
        catch: () => new CredentialBrokerError({}),
      }),
    subscribe: (sessionId, viewId) =>
      Stream.callback<CredentialBrokerState, CredentialBrokerError>(
        (queue) =>
          Effect.acquireRelease(
            Effect.try({
              try: () =>
                broker.subscribe(sessionId, viewId, (state) => {
                  Queue.offerUnsafe(queue, state);
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
