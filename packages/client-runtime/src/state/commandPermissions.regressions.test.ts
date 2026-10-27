import { requestGuarded, runStreamGuarded } from "../rpc/client.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { RpcSession } from "../rpc/session.ts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthAccessWriteScope,
  AuthSettingsWriteScope,
  AuthEnvironmentMaintainScope,
  AuthSourceControlWriteScope,
  ThreadId,
  EnvironmentId,
  ScheduledTaskId,
  WS_METHODS,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("target");
const other = EnvironmentId.make("other");
const grant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthOrchestrationOperateScope] : [],
  permissions: allowed ? [AuthOrchestrationOperateScope] : [],
});
const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry, {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
  } as unknown as EnvironmentRegistry["Service"]),
);
const permissions = createCommandPermissions(runtime, WS_METHODS.scheduledTasksDelete);
const setup = Effect.gen(function* () {
  const registry = AtomRegistry.make();
  registry.mount(sessions(env));
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return registry;
});

describe("command permissions", () => {
  it.effect("requires operate access to broadcast notifications", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const send = createCommandPermissions(runtime, WS_METHODS.notificationsSend);
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthOrchestrationReadScope],
            permissions: [AuthOrchestrationReadScope],
          }),
        );
        expect(registry.get(send.permissionAtom(env))).toBe(false);
        const denied = yield* send.authorize(registry, env).pipe(Effect.flip);
        expect(denied._tag).toBe("EnvironmentAuthorizationError");
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(send.permissionAtom(env))).toBe(true);
        yield* send.authorize(registry, env);
      }),
    ),
  );

  it.effect("requires read access to subscribe this device to push", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const push = createCommandPermissions(runtime, WS_METHODS.webPushUpdate);
        registry.set(
          sessions(env),
          AsyncResult.success({ ...grant(false), scopes: [], permissions: [] }),
        );
        expect(registry.get(push.permissionAtom(env))).toBe(false);
        const denied = yield* push.authorize(registry, env).pipe(Effect.flip);
        expect(denied._tag).toBe("EnvironmentAuthorizationError");
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthOrchestrationReadScope],
            permissions: [AuthOrchestrationReadScope],
          }),
        );
        expect(registry.get(push.permissionAtom(env))).toBe(true);
        yield* push.authorize(registry, env);
      }),
    ),
  );

  it.effect("requires the destination settings grant to check OTLP endpoints", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const check = createCommandPermissions(runtime, WS_METHODS.serverCheckOtlpEndpoint);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(check.permissionAtom(env))).toBe(false);
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(check.permissionAtom(env))).toBe(true);
        yield* check.authorize(registry, env);
      }),
    ),
  );

  it.effect(
    "requires the destination environment maintenance grant for queued deployment actions",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          const deployment = createCommandPermissions(runtime, WS_METHODS.serverDeploymentAction);
          registry.set(sessions(env), AsyncResult.success(grant(true)));
          expect(registry.get(deployment.permissionAtom(env))).toBe(false);
          const maintenance = {
            ...grant(false),
            scopes: [AuthEnvironmentMaintainScope],
            permissions: [AuthEnvironmentMaintainScope],
          };
          registry.set(sessions(env), AsyncResult.success(maintenance));
          expect(registry.get(deployment.permissionAtom(env))).toBe(true);
          yield* deployment.authorize(registry, env);
          registry.set(sessions(other), AsyncResult.success(grant(true)));
          expect(registry.get(deployment.permissionAtom(other))).toBe(false);
          const denied = yield* deployment.authorize(registry, other).pipe(Effect.flip);
          expect(denied._tag).toBe("EnvironmentAuthorizationError");
        }),
      ),
  );

  it.effect("bounds a session that never loads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const fiber = yield* permissions
          .authorize(registry, env)
          .pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("6 seconds");
        expect((yield* Fiber.join(fiber))._tag).toBe("EnvironmentAuthorizationError");
      }),
    ),
  );
});

it.effect(
  "credential decisions require human access permission on the destination environment",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const credentialPermissions = createCommandPermissions(
          runtime,
          WS_METHODS.credentialBrokerAction,
        );
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(credentialPermissions.permissionAtom(env))).toBe(false);
        expect(
          yield* credentialPermissions.authorize(registry, env, { type: "lock" }).pipe(Effect.flip),
        ).toMatchObject({ requiredScope: AuthAccessWriteScope });
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthAccessWriteScope],
            permissions: [AuthAccessWriteScope],
          }),
        );
        expect(registry.get(credentialPermissions.permissionAtom(env))).toBe(true);
        yield* credentialPermissions.authorize(registry, env, { type: "lock" });
        registry.set(sessions(other), AsyncResult.success(grant(true)));
        expect(
          yield* credentialPermissions
            .authorize(registry, other, { type: "lock" })
            .pipe(Effect.flip),
        ).toMatchObject({ requiredScope: AuthAccessWriteScope });
      }),
    ),
);
