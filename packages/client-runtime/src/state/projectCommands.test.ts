import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  ThreadId,
  type ProjectResourceLock,
  type ProjectMutation,
  EnvironmentId,
  ProjectId,
  type ScopedProjectRef,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { EnvironmentProject } from "./models.ts";
import { createProjectEnvironmentAtoms } from "./projectCommands.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("scratch");
const PROJECT = {
  id: PROJECT_ID,
  environmentId: ENVIRONMENT_ID,
  workspaceRoot: "/scratch",
} as EnvironmentProject;

const makeHarness = Effect.fn("TestProjectCommands.makeHarness")(function* (
  resourceReply?: (input: ProjectMutation) => Effect.Effect<EnvironmentProject>,
) {
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: { environmentId: ENVIRONMENT_ID },
    session: yield* SubscriptionRef.make(
      Option.some({
        client: {
          [WS_METHODS.projectsEnsureScratch]: () => Effect.succeed({ projectId: PROJECT_ID }),
          [WS_METHODS.projectsMutate]: resourceReply,
        },
      } as unknown as RpcSession),
    ),
  } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
    ),
  );
  const storedProject = Atom.make<EnvironmentProject | null>(null);
  const commands = createProjectEnvironmentAtoms(runtime, {
    projectAtom: (ref: ScopedProjectRef) =>
      ref.environmentId === ENVIRONMENT_ID && ref.projectId === PROJECT_ID
        ? storedProject
        : Atom.make(null),
  });
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const openScratch = Effect.promise(() =>
    commands.openScratch.run(registry, { environmentId: ENVIRONMENT_ID, input: {} }),
  );
  return { registry, storedProject, openScratch, commands };
});

describe("openScratch", () => {
  it.effect("resolves once the created project reaches the client store", () =>
    Effect.gen(function* () {
      const { registry, storedProject, openScratch } = yield* makeHarness();
      const opening = yield* Effect.forkChild(openScratch);
      yield* Effect.yieldNow;
      registry.set(storedProject, PROJECT);
      const result = yield* Fiber.join(opening);
      expect(result).toMatchObject({ _tag: "Success", value: PROJECT });
    }).pipe(Effect.scoped),
  );
});

const resource: ProjectResourceLock = {
  threadId: ThreadId.make("owner"),
  operationId: CommandId.make("held"),
  phase: "held",
  script: {
    id: "sandbox",
    name: "SANDBOX",
    command: "",
    icon: "configure",
    runOnWorktreeCreate: false,
    resource: {
      color: "#abcdef",
      checkoutPrompt: "",
      releasePrompt: "",
      releaseCommand: "cleanup",
    },
  },
};

describe("releaseThreadResources", () => {
  it.effect.each([false, true])(
    "waits for release completion and reports hook failure=%s",
    (failed) =>
      Effect.gen(function* () {
        const requested = yield* Deferred.make<void>();
        const releasing = {
          ...resource,
          operationId: CommandId.make("release"),
          phase: "release" as const,
        };
        const h = yield* makeHarness((input) =>
          Effect.gen(function* () {
            expect(input).toMatchObject({
              action: "release",
              expectedOperationId: resource.operationId,
            });
            yield* Deferred.succeed(requested, undefined);
            return { ...PROJECT, resourceLocks: [releasing] };
          }),
        );
        h.registry.set(h.storedProject, { ...PROJECT, resourceLocks: [resource] });
        const running = yield* Effect.forkChild(
          Effect.promise(() =>
            h.commands.releaseThreadResources.run(h.registry, {
              environmentId: ENVIRONMENT_ID,
              input: { projectId: PROJECT_ID, threadId: resource.threadId, locks: [resource] },
            }),
          ),
        );
        yield* Deferred.await(requested);
        h.registry.set(h.storedProject, { ...PROJECT, resourceLocks: [releasing] });
        expect(running.pollUnsafe()).toBeUndefined();
        h.registry.set(h.storedProject, {
          ...PROJECT,
          resourceLocks: failed ? [{ ...releasing, phase: "failed", error: "cleanup failed" }] : [],
        });
        const result = yield* Fiber.join(running);
        expect(result._tag).toBe(failed ? "Failure" : "Success");
      }).pipe(Effect.scoped),
  );
});
