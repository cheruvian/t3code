// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { storageCleanupActivityAt, storageCleanupThreadIdle, make } from "./storageCleanup.ts";
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerConfig from "./config.ts";
import * as Settings from "./serverSettings.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as GitManager from "./git/GitManager.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

describe("V2 storage cleanup eligibility", () => {
  const candidate = () => shell({ branch: "feature", worktreePath: "/worktrees/feature" });

  it("allows an idle worktree and rejects the project checkout", () => {
    expect(storageCleanupThreadIdle(candidate(), NOW_MS)).toBe(true);
    expect(storageCleanupThreadIdle(shell(), NOW_MS)).toBe(false);
  });

  it.each(["running", "starting", "preparing", "waiting", "queued"] as const)(
    "retains a worktree while its thread is %s",
    (status) => {
      expect(storageCleanupThreadIdle(candidateWithStatus(status), NOW_MS)).toBe(false);
    },
  );

  it("retains an active run even if the shell status is idle", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), activeRunId: RunId.make("run") }, NOW_MS),
    ).toBe(false);
  });

  it("retains a queued prompt before the new run has been projected", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), latestUserMessageAt: at(-1_000) }, NOW_MS),
    ).toBe(false);
  });

  it("uses V2 run activity instead of metadata refreshes for retention", () => {
    const thread = candidate();
    const runTime = at(-3 * DAY_MS);
    expect(
      storageCleanupActivityAt({ ...thread, latestRunCompletedAt: runTime, updatedAt: at(0) }),
    ).toBe(DateTime.toEpochMillis(runTime));
  });

  function candidateWithStatus(status: OrchestrationV2ThreadShell["status"]) {
    return { ...candidate(), status };
  }
});

describe("confirmed worktree removal", () => {
  it.effect.each(["delete", "shared", "changed", "active"] as const)(
    "%s: honors a clean preview while retaining shared, changed, and active worktrees",
    (scenario) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const tempDir = yield* fs.makeTempDirectoryScoped();
          const baseDir = yield* fs.realPath(tempDir);
          const repo = `${baseDir}/repo`;
          const worktree = `${baseDir}/worktrees/feature`;
          yield* fs.makeDirectory(repo);
          const git = (...args: string[]) =>
            NodeChildProcess.execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString();
          git("init");
          yield* fs.writeFileString(`${repo}/.gitignore`, ".env\n");
          git("add", ".gitignore");
          git(
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "initial",
          );
          git("worktree", "add", "-b", "feature", worktree);
          yield* fs.writeFileString(`${worktree}/.env`, "LOCAL_CONFIG=fixture\n");
          if (scenario === "changed")
            yield* fs.writeFileString(`${worktree}/new.txt`, "new work\n");
          const thread = shell({
            branch: "feature",
            worktreePath: worktree,
            settledAt: at(-1000),
            ...(scenario === "active"
              ? { status: "running", activeRunId: RunId.make("active") }
              : {}),
          });
          const project = {
            id: thread.projectId,
            title: "Fixture",
            workspaceRoot: repo,
            defaultModelSelection: null,
            scripts: [],
            repositoryIdentity: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          };
          const dependencies = Layer.mergeAll(
            Layer.mock(Settings.ServerSettingsService)({}),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () => Effect.succeed([project]),
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getShellSnapshot: (options) =>
                Effect.succeed({
                  schemaVersion: 1,
                  snapshotSequence: 0,
                  archivedThreads: [],
                  threads:
                    options?.location === "archive"
                      ? []
                      : scenario === "shared"
                        ? [thread, { ...thread, id: ThreadId.make("other") }]
                        : [thread],
                }),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({}),
            Layer.mock(GitManager.GitManager)({ invalidateStatus: () => Effect.void }),
            Layer.mock(TerminalManager.TerminalManager)({}),
            GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer)),
            SqlitePersistenceMemory,
          ).pipe(
            Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
            Layer.provide(NodeServices.layer),
          );
          const removed = yield* Effect.gen(function* () {
            const cleanup = yield* make;
            return yield* cleanup.removeConfirmedWorktree({
              threadId: thread.id,
              expectedRefName: "feature",
              expectedFiles: [],
            });
          }).pipe(Effect.provide(dependencies));
          expect(removed).toBe(scenario === "delete");
          expect(yield* fs.exists(`${worktree}/.env`)).toBe(scenario !== "delete");
          expect(git("branch", "--list", "feature")).toContain("feature");
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );
});
