import {
  ProviderSessionId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

export class NativeSessionResumeProbeError extends Schema.TaggedError<NativeSessionResumeProbeError>()(
  "NativeSessionResumeProbeError",
  {
    instanceId: Schema.String,
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Provider-native session resume probe failed for ${this.threadId}.`;
  }
}

export interface NativeSessionResumeProbeInput {
  readonly instanceId: ProviderInstanceId;
  readonly thread: OrchestrationV2AppThread;
  readonly providerThread: OrchestrationV2ProviderThread;
}

export class NativeSessionResumeProbe extends Context.Service<
  NativeSessionResumeProbe,
  {
    readonly probe: (
      input: NativeSessionResumeProbeInput,
    ) => Effect.Effect<OrchestrationV2ProviderThread, NativeSessionResumeProbeError>;
  }
>()("t3/orchestration-v2/NativeSessionResumeProbe") {}

export const layer = Layer.effect(
  NativeSessionResumeProbe,
  Effect.gen(function* () {
    const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
    return NativeSessionResumeProbe.of({
      probe: Effect.fn("NativeSessionResumeProbe.probe")(function* (input) {
        const nativeRef = input.providerThread.nativeThreadRef;
        if (nativeRef?.strength !== "strong" || nativeRef.nativeId === null) {
          return yield* new NativeSessionResumeProbeError({
            instanceId: input.instanceId,
            threadId: input.thread.id,
            cause: "A strong provider-native session id is required.",
          });
        }
        const nativeThreadId = nativeRef.nativeId;
        const modelSelection = { ...input.thread.modelSelection, instanceId: input.instanceId };
        const destinationThread = {
          ...input.thread,
          providerInstanceId: input.instanceId,
          modelSelection,
        };
        const destinationProviderThread = {
          ...input.providerThread,
          providerInstanceId: input.instanceId,
          providerSessionId: null,
          status: "not_loaded" as const,
        };
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* adapters.get(input.instanceId);
            if (adapter.driver !== input.providerThread.driver) {
              return yield* Effect.fail("The destination provider driver is incompatible.");
            }
            const policy = yield* runtimePolicy.resolve({
              thread: destinationThread,
              modelSelection,
            });
            if (adapter.driver === "claudeAgent" && adapter.validateNativeThread === undefined) {
              return yield* Effect.fail(
                "The Claude adapter does not expose native-session validation.",
              );
            }
            if (adapter.validateNativeThread !== undefined) {
              if (policy.cwd === null) {
                return yield* Effect.fail("Native-session validation requires a workspace.");
              }
              yield* adapter.validateNativeThread({
                nativeThreadId,
                cwd: policy.cwd,
              });
            }
            const runtime = yield* adapter.openSession({
              threadId: destinationThread.id,
              providerSessionId: ProviderSessionId.make(
                `thread-move-probe:${destinationThread.id}:${input.instanceId}`,
              ),
              modelSelection,
              runtimePolicy: policy,
              initialNativeThreadId: nativeThreadId,
              ...(input.providerThread.nativeMetadata?.itemIdentityVersion === undefined
                ? {}
                : {
                    initialProviderItemIdentityVersion:
                      input.providerThread.nativeMetadata.itemIdentityVersion,
                  }),
            });
            const resumed = yield* runtime.resumeThread({
              providerThread: destinationProviderThread,
              threadId: destinationThread.id,
              modelSelection,
              runtimePolicy: policy,
            });
            if (
              resumed.nativeThreadRef?.strength !== "strong" ||
              resumed.nativeThreadRef.nativeId !== nativeThreadId
            ) {
              return yield* Effect.fail("The provider resumed a different native session.");
            }
            return resumed;
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new NativeSessionResumeProbeError({
                instanceId: input.instanceId,
                threadId: input.thread.id,
                cause,
              }),
          ),
        );
      }),
    });
  }),
);
