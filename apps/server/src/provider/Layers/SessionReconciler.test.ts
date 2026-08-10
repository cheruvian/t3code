import {
  CommandId,
  type OrchestrationCommand,
  type OrchestrationSession,
  type OrchestrationShellSnapshot,
  ProviderDriverKind,
  ProviderSessionGeneration,
  ServerOwnerGeneration,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../Services/ProviderSessionDirectory.ts";
import { SessionReconciler } from "../Services/SessionReconciler.ts";
import {
  isOrphanedActiveSession,
  isActiveShell,
  SessionReconcilerLive,
} from "./SessionReconciler.ts";

const owner = ServerOwnerGeneration.make("owner-current");
const baseBinding = {
  threadId: ThreadId.make("thread-1"),
  provider: ProviderDriverKind.make("codex"),
  status: "running" as const,
  ownerGeneration: owner,
  sessionGeneration: ProviderSessionGeneration.make("session-1"),
};

describe("SessionReconciler orphan classification", () => {
  it("treats missing, stopped, legacy, and prior-owner active bindings as orphaned", () => {
    expect(isOrphanedActiveSession(undefined, owner)).toBe(true);
    expect(isOrphanedActiveSession({ ...baseBinding, status: "stopped" }, owner)).toBe(true);
    expect(isOrphanedActiveSession({ ...baseBinding, ownerGeneration: null }, owner)).toBe(true);
    expect(
      isOrphanedActiveSession(
        { ...baseBinding, ownerGeneration: ServerOwnerGeneration.make("owner-old") },
        owner,
      ),
    ).toBe(true);
  });

  it("preserves a current-owner running binding", () => {
    expect(isOrphanedActiveSession(baseBinding, owner)).toBe(false);
  });

  it("never classifies ready shells as active, regardless of runtime status", () => {
    const ready = {
      session: { status: "ready" },
    } as unknown as Parameters<typeof isActiveShell>[0];
    expect(isActiveShell(ready)).toBe(false);
    expect(isOrphanedActiveSession({ ...baseBinding, status: "running" }, owner)).toBe(false);
    expect(isOrphanedActiveSession({ ...baseBinding, status: "stopped" }, owner)).toBe(true);
  });
});

effectIt.effect("reconciles prior-owner active work once through durable session commands", () => {
  const threadId = ThreadId.make("thread-reconcile-running");
  let session: OrchestrationSession = {
    threadId,
    status: "running" as const,
    providerName: "codex",
    runtimeMode: "full-access" as const,
    activeTurnId: TurnId.make("turn-1"),
    lastError: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  let binding: ProviderRuntimeBinding = {
    ...baseBinding,
    threadId,
    ownerGeneration: ServerOwnerGeneration.make("owner-prior"),
  };
  const commands: OrchestrationCommand[] = [];
  const snapshot = () =>
    ({
      threads: [
        {
          id: threadId,
          session,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
        },
      ],
    }) as unknown as OrchestrationShellSnapshot;
  const dependencies = Layer.mergeAll(
    Layer.succeed(ProjectionSnapshotQuery, {
      getShellSnapshot: () => Effect.succeed(snapshot()),
    } as never),
    Layer.succeed(ProviderSessionDirectory, {
      ownerGeneration: owner,
      getBinding: () => Effect.succeed(Option.some(binding)),
      upsert: (next: ProviderRuntimeBinding) => Effect.sync(() => ((binding = next), true)),
    } as never),
    Layer.succeed(ProviderService, {
      runIfCurrentGeneration: (_input: unknown, effect: Effect.Effect<unknown>) =>
        Effect.map(effect, Option.some),
    } as never),
    Layer.succeed(OrchestrationEngineService, {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          commands.push(command);
          if (command.type === "thread.session.set") session = command.session as typeof session;
          return { sequence: commands.length };
        }),
    } as never),
  );
  return Effect.gen(function* () {
    const reconciler = yield* SessionReconciler;
    const first = yield* reconciler.reconcileOrphanedSessions;
    expect(first).toMatchObject({ reconciled: 1, interrupted: 1, stopped: 0 });
    expect(session.status).toBe("interrupted");
    expect(session.activeTurnId).toBeNull();
    expect(binding).toMatchObject({ status: "stopped", terminalDisposition: "interrupted" });

    const second = yield* reconciler.reconcileOrphanedSessions;
    expect(second.reconciled).toBe(0);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.commandId).toBe(
      CommandId.make(`provider-reconcile:${threadId}:session-1:interrupted`),
    );

    session = { ...session, status: "ready", activeTurnId: null };
    binding = { ...binding, status: "running", ownerGeneration: owner };
    const shutdown = yield* reconciler.interruptActiveSessions;
    expect(shutdown).toMatchObject({ reconciled: 1, interrupted: 0, stopped: 1 });
    expect(session.status).toBe("stopped");
  }).pipe(Effect.provide(SessionReconcilerLive.pipe(Layer.provide(dependencies))));
});
