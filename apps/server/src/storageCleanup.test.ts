// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  OrchestrationV2ProviderSessionJson,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  storageCleanupActivityAt,
  storageCleanupPullRequestMerged,
  storageCleanupThreadIdle,
  make,
} from "./storageCleanup.ts";

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
import { layerMemory } from "./persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/ClaudeAdapterV2.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;
const encodeCleanupSession = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);

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

  it.each(["idle", "completed", "interrupted", "failed", "cancelled", "rolled_back"] as const)(
    "allows cleanup once its thread is %s",
    (status) => {
      expect(storageCleanupThreadIdle(candidateWithStatus(status), NOW_MS)).toBe(true);
    },
  );

  it.each(["completed", "interrupted", "cancelled", "rolled_back"] as const)(
    "retains %s while background work is pending",
    (status) => {
      expect(
        storageCleanupThreadIdle(
          {
            ...candidateWithStatus(status),
            pendingBackgroundTasks: [{ taskId: "task-1", kind: "command" }],
          },
          NOW_MS,
        ),
      ).toBe(false);
    },
  );

  it.each(["completed", "interrupted", "cancelled", "rolled_back"] as const)(
    "retains %s while a runtime request is pending",
    (status) => {
      expect(
        storageCleanupThreadIdle(
          {
            ...candidateWithStatus(status),
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("request-1"),
              kind: "command",
              createdAt: at(0),
            },
          },
          NOW_MS,
        ),
      ).toBe(false);
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

describe("merged pull request cleanup", () => {
  const HEAD_SHA = "a".repeat(40);
  const integrated = {
    branch: "feature",
    defaultBranch: "main",
    headSha: HEAD_SHA,
    integrated: true,
  };
  const squashed = { ...integrated, integrated: false };
  const pullRequest = (
    overrides: Partial<NonNullable<Parameters<typeof storageCleanupPullRequestMerged>[0]>> = {},
  ) => ({
    state: "merged" as const,
    headRef: "feature",
    baseRef: "main",
    headSha: HEAD_SHA,
    ...overrides,
  });

  it("removes a worktree whose head reached the default branch through a merged pull request", () => {
    expect(storageCleanupPullRequestMerged(pullRequest({ headSha: null }), integrated)).toBe(true);
  });

  it("removes a squash-merged worktree when the pull request names its exact head", () => {
    expect(storageCleanupPullRequestMerged(pullRequest(), squashed)).toBe(true);
  });

  it.each([
    ["has a later commit than the merged head", { headSha: "c".repeat(40) }],
    ["was merged into a release branch", { baseRef: "release" }],
    ["was merged into its stack parent", { baseRef: "stack-parent" }],
    ["was merged without a reported head commit", { headSha: null }],
    ["belongs to a different branch", { headRef: "other" }],
    ["is still open", { state: "open" }],
    ["was closed without merging", { state: "closed" }],
  ] as const)("keeps a squash worktree whose pull request %s", (_name, overrides) => {
    expect(storageCleanupPullRequestMerged(pullRequest(overrides), squashed)).toBe(false);
  });

  it("keeps a worktree with no pull request, or one that is not merged", () => {
    expect(storageCleanupPullRequestMerged(null, squashed)).toBe(false);
    expect(storageCleanupPullRequestMerged(null, integrated)).toBe(false);
    expect(storageCleanupPullRequestMerged(pullRequest({ state: "open" }), integrated)).toBe(false);
  });
});

describe.each(["confirmed", "settled"] as const)("%s worktree removal", (mode) => {
  it.effect.each([
    "delete",
    "linked-parent",
    "linked-parent-shared",
    "linked-session",
    "stale-shared-session",
    "attached-shared-session",
    "nested-shared-session",
    "dedicated-session",
    "linked-worktree",
    "shared",
    "changed",
    "active",
  ] as const)(
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
          git("remote", "add", "origin", repo);
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
          const linkedBaseDir = `${baseDir}/linked`;
          if (
            scenario === "linked-parent" ||
            scenario === "linked-parent-shared" ||
            scenario === "linked-session"
          ) {
            yield* fs.symlink(baseDir, linkedBaseDir);
          }
          if (scenario === "linked-worktree") {
            yield* fs.symlink(worktree, `${baseDir}/worktrees/linked-feature`);
          }
          const threadWorktree =
            scenario === "linked-parent" || scenario === "linked-parent-shared"
              ? `${linkedBaseDir}/worktrees/feature`
              : scenario === "linked-worktree"
                ? `${baseDir}/worktrees/linked-feature`
                : worktree;
          if (mode === "confirmed")
            yield* fs.writeFileString(`${worktree}/.env`, "LOCAL_CONFIG=fixture\n");
          if (scenario === "changed")
            yield* fs.writeFileString(`${worktree}/new.txt`, "new work\n");
          const thread = shell({
            branch: "feature",
            worktreePath: threadWorktree,
            settledAt: at(-1000),
            ...(scenario === "active"
              ? { status: "running", activeRunId: RunId.make("active") }
              : {}),
          });
          const otherThread = shell({
            id: ThreadId.make("other"),
            worktreePath: scenario === "nested-shared-session" ? `${worktree}/nested` : null,
          });
          if (scenario === "nested-shared-session") yield* fs.makeDirectory(`${worktree}/nested`);
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
            Layer.mock(Settings.ServerSettingsService)({
              getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
            }),
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
                      : scenario === "shared" || scenario === "linked-parent-shared"
                        ? [
                            thread,
                            { ...thread, id: ThreadId.make("other"), worktreePath: worktree },
                          ]
                        : scenario === "stale-shared-session" ||
                            scenario === "nested-shared-session"
                          ? [thread, otherThread]
                          : [thread],
                }),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({}),
            Layer.mock(GitManager.GitManager)({ invalidateStatus: () => Effect.void }),
            Layer.mock(TerminalManager.TerminalManager)({}),
            GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer)),
            layerMemory,
          ).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(
                scenario === "linked-parent" || scenario === "linked-parent-shared"
                  ? linkedBaseDir
                  : baseDir,
                baseDir,
              ),
            ),
            Layer.provide(NodeServices.layer),
          );
          const removed = yield* Effect.gen(function* () {
            const cleanup = yield* make;
            if (
              scenario === "linked-session" ||
              scenario === "stale-shared-session" ||
              scenario === "attached-shared-session" ||
              scenario === "nested-shared-session" ||
              scenario === "dedicated-session"
            ) {
              const sql = yield* SqlClient.SqlClient;
              const payload = yield* encodeCleanupSession({
                id: ProviderSessionId.make("live-session"),
                driver: ProviderDriverKind.make(
                  scenario === "dedicated-session" || scenario === "linked-session"
                    ? "claudeAgent"
                    : "codex",
                ),
                providerInstanceId: thread.providerInstanceId,
                status: "ready",
                cwd:
                  scenario === "linked-session" ? `${linkedBaseDir}/worktrees/feature` : worktree,
                model: null,
                capabilities:
                  scenario === "dedicated-session" || scenario === "linked-session"
                    ? ClaudeProviderCapabilitiesV2
                    : CodexProviderCapabilitiesV2,
                createdAt: at(-1000),
                updatedAt: at(-1000),
                lastError: null,
              });
              yield* sql`
                INSERT INTO orchestration_v2_projection_provider_sessions
                  (provider_session_id, thread_id, provider, status, updated_at, payload_json)
                VALUES ('live-session', ${otherThread.id}, 'codex', 'ready',
                  '2026-06-10T11:59:59.000Z', ${payload})
              `;
              if (scenario !== "dedicated-session" && scenario !== "linked-session") {
                const boundThreadId =
                  scenario === "stale-shared-session" || scenario === "nested-shared-session"
                    ? otherThread.id
                    : thread.id;
                yield* sql`
                  INSERT INTO orchestration_v2_projection_provider_session_bindings
                    (provider_session_id, thread_id)
                  VALUES ('live-session', ${boundThreadId})
                `;
                // Bindings, rather than the session row's most recent thread,
                // identify every workspace still attached to a shared runtime.
                for (const boundThread of [thread, otherThread]) {
                  yield* sql`
                    INSERT INTO orchestration_v2_projection_threads
                      (thread_id, project_id, title, default_provider, runtime_mode,
                        interaction_mode, created_at, updated_at, payload_json)
                    VALUES (${boundThread.id}, ${boundThread.projectId}, ${boundThread.title},
                      'codex', 'full-access', 'default', '2026-06-10T11:59:59.000Z',
                      '2026-06-10T11:59:59.000Z',
                      ${JSON.stringify({ worktreePath: boundThread.worktreePath })})
                  `;
                }
                yield* sql`
                  INSERT INTO projection_projects
                    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
                  VALUES (${project.id}, ${project.title}, ${repo},
                    '[]', '2026-06-10T11:59:59.000Z', '2026-06-10T11:59:59.000Z')
                `;
              }
            }
            if (mode === "settled") {
              const paths = yield* cleanup.removeSettledWorktrees("pushed");
              return paths.length > 0;
            }
            return yield* cleanup.removeConfirmedWorktree({
              threadId: thread.id,
              expectedRefName: "feature",
              expectedFiles: [],
            });
          }).pipe(Effect.provide(dependencies));
          const shouldRemove =
            scenario === "delete" ||
            scenario === "linked-parent" ||
            scenario === "stale-shared-session";
          expect(removed).toBe(shouldRemove);
          expect(yield* fs.exists(worktree)).toBe(!shouldRemove);
          if (mode === "confirmed")
            expect(yield* fs.exists(`${worktree}/.env`)).toBe(!shouldRemove);
          expect(git("branch", "--list", "feature")).toContain("feature");
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );
});
