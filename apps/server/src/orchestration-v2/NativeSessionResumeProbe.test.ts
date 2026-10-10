import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as NativeSessionResumeProbe from "./NativeSessionResumeProbe.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";

const threadId = ThreadId.make("thread-move-probe");
const instanceId = ProviderInstanceId.make("destination-codex");
const nativeId = "019fbbc1-b12c-7360-a685-28c181f0025f";
const thread = {
  id: threadId,
  projectId: "project-move-probe",
  providerInstanceId: ProviderInstanceId.make("source-codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("source-codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  worktreePath: "/destination/worktree",
} as unknown as OrchestrationV2AppThread;
const providerThread = {
  id: ProviderThreadId.make("provider-thread-move-probe"),
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("source-codex"),
  providerSessionId: null,
  appThreadId: threadId,
  nativeThreadRef: { driver: "codex", nativeId, strength: "strong" },
  nativeMetadata: { itemIdentityVersion: 2 },
  status: "idle",
} as unknown as OrchestrationV2ProviderThread;

describe("NativeSessionResumeProbe", () => {
  it.effect("loads and resumes the exact native id without starting a turn", () => {
    let openedNativeId: string | undefined;
    let resumedNativeId: string | null | undefined;
    const layer = NativeSessionResumeProbe.layer.pipe(
      Layer.provide(
        Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
          list: () => Effect.succeed([instanceId]),
          get: () =>
            Effect.succeed({
              instanceId,
              driver: ProviderDriverKind.make("codex"),
              getCapabilities: () => Effect.die("unused"),
              planSelectionTransition: () => Effect.die("unused"),
              openSession: (input) => {
                openedNativeId = input.initialNativeThreadId;
                return Effect.succeed({
                  instanceId,
                  driver: ProviderDriverKind.make("codex"),
                  providerSessionId: input.providerSessionId,
                  providerSession: {} as never,
                  events: Stream.empty,
                  ensureThread: () => Effect.die("unused"),
                  resumeThread: ({ providerThread }) => {
                    resumedNativeId = providerThread.nativeThreadRef?.nativeId;
                    return Effect.succeed(providerThread);
                  },
                  startTurn: () => Effect.die("resume probe must not start a turn"),
                  steerTurn: () => Effect.die("unused"),
                  interruptTurn: () => Effect.die("unused"),
                  respondToRuntimeRequest: () => Effect.die("unused"),
                  readThreadSnapshot: () => Effect.die("unused"),
                  rollbackThread: () => Effect.die("unused"),
                  forkThread: () => Effect.die("unused"),
                });
              },
            } as ProviderAdapterV2Shape),
        }),
      ),
      Layer.provide(
        Layer.succeed(RuntimePolicy.RuntimePolicyV2, {
          resolve: ({ thread }) =>
            Effect.succeed({
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              cwd: thread.worktreePath,
            }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const probe = yield* NativeSessionResumeProbe.NativeSessionResumeProbe;
      const resumed = yield* probe.probe({ instanceId, thread, providerThread });
      assert.equal(openedNativeId, nativeId);
      assert.equal(resumedNativeId, nativeId);
      assert.equal(resumed.nativeThreadRef?.nativeId, nativeId);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects a loader that allocates a different native id", () => {
    const layer = NativeSessionResumeProbe.layer.pipe(
      Layer.provide(
        Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
          list: () => Effect.succeed([instanceId]),
          get: () =>
            Effect.succeed({
              instanceId,
              driver: ProviderDriverKind.make("codex"),
              getCapabilities: () => Effect.die("unused"),
              planSelectionTransition: () => Effect.die("unused"),
              openSession: (input) =>
                Effect.succeed({
                  instanceId,
                  driver: ProviderDriverKind.make("codex"),
                  providerSessionId: input.providerSessionId,
                  providerSession: {} as never,
                  events: Stream.empty,
                  ensureThread: () => Effect.die("unused"),
                  resumeThread: ({ providerThread }) =>
                    Effect.succeed({
                      ...providerThread,
                      nativeThreadRef: {
                        driver: ProviderDriverKind.make("codex"),
                        nativeId: "fresh-native-id",
                        strength: "strong",
                      },
                    }),
                  startTurn: () => Effect.die("unused"),
                  steerTurn: () => Effect.die("unused"),
                  interruptTurn: () => Effect.die("unused"),
                  respondToRuntimeRequest: () => Effect.die("unused"),
                  readThreadSnapshot: () => Effect.die("unused"),
                  rollbackThread: () => Effect.die("unused"),
                  forkThread: () => Effect.die("unused"),
                }),
            } as ProviderAdapterV2Shape),
        }),
      ),
      Layer.provide(RuntimePolicy.layer),
    );

    return Effect.gen(function* () {
      const probe = yield* NativeSessionResumeProbe.NativeSessionResumeProbe;
      const exit = yield* Effect.exit(probe.probe({ instanceId, thread, providerThread }));
      assert.isTrue(exit._tag === "Failure");
    }).pipe(Effect.provide(layer));
  });
});
