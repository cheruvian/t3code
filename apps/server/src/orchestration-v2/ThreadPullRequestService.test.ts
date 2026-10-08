import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as GitManager from "../git/GitManager.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadPullRequestService from "./ThreadPullRequestService.ts";

describe("ThreadPullRequestServiceV2 project guard", () => {
  it.effect("discovers a repository from a project shell without enrichment", () =>
    Effect.gen(function* () {
      const project: OrchestrationProjectShell = {
        id: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        scripts: [],
        repositoryIdentity: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      };
      let resolvedRoot: string | null = null;
      const result = yield* ThreadPullRequestService.resolveProjectForPullRequestDiscovery(
        project,
        {
          resolve: (root) => {
            resolvedRoot = root;
            return Effect.succeed({
              canonicalKey: "github.com/pingdotgg/t3code",
              locator: {
                source: "git-remote" as const,
                remoteName: "origin",
                remoteUrl: "git@github.com:pingdotgg/t3code.git",
              },
              provider: "github" as const,
              displayName: "pingdotgg/t3code",
              owner: "pingdotgg",
              name: "t3code",
            });
          },
        },
      );
      expect(resolvedRoot).toBe("/workspace/project");
      expect(result.repository).toBe("pingdotgg/t3code");
      expect(result.project.repositoryIdentity?.canonicalKey).toBe("github.com/pingdotgg/t3code");
    }),
  );

  it.effect("refreshes the cached repository identity only when asked", () =>
    Effect.gen(function* () {
      const project: OrchestrationProjectShell = {
        id: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        scripts: [],
        repositoryIdentity: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      };
      const refreshes: Array<boolean | undefined> = [];
      const resolver = {
        resolve: (_root: string, options?: { readonly refresh?: boolean }) => {
          refreshes.push(options?.refresh);
          return Effect.succeed(null);
        },
      };
      yield* ThreadPullRequestService.resolveProjectForPullRequestDiscovery(project, resolver);
      yield* ThreadPullRequestService.resolveProjectForPullRequestDiscovery(project, resolver, {
        refresh: true,
      });
      expect(refreshes).toEqual([false, true]);
    }),
  );

  it("rejects a pull-request result when the project root changes before dispatch", () => {
    const currentProject = Option.some({
      workspaceRoot: "/workspace/replaced",
    } satisfies Pick<OrchestrationProjectShell, "workspaceRoot">);

    expect(
      ThreadPullRequestService.projectWorkspaceMatchesSnapshot(
        currentProject,
        "/workspace/original",
      ),
    ).toBe(false);
  });

  it("rejects a pull-request result when the project was deleted before dispatch", () => {
    expect(
      ThreadPullRequestService.projectWorkspaceMatchesSnapshot(
        Option.none<Pick<OrchestrationProjectShell, "workspaceRoot">>(),
        "/workspace/original",
      ),
    ).toBe(false);
  });

  it("accepts a pull-request result while the project root is unchanged", () => {
    const currentProject = Option.some({
      workspaceRoot: "/workspace/original",
    } satisfies Pick<OrchestrationProjectShell, "workspaceRoot">);

    expect(
      ThreadPullRequestService.projectWorkspaceMatchesSnapshot(
        currentProject,
        "/workspace/original",
      ),
    ).toBe(true);
  });
});

describe("ThreadPullRequestServiceV2 reads", () => {
  const NOW = DateTime.makeUnsafe("2026-09-20T00:00:00.000Z");
  const threadShell = (id: string): OrchestrationV2ThreadShell => {
    const threadId = ThreadId.make(id);
    return {
      id: threadId,
      projectId: ProjectId.make("project-1"),
      title: id,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      activeRunId: null,
      latestRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
  };

  it.effect("an event reads only the target thread's discovery metadata", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = threadShell("updated-thread");
        const other = threadShell("other-thread");
        const activation = yield* Deferred.make<void>();
        const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
        // Each read: the thread id for a one-thread read, or the full read's options.
        const reads = yield* Queue.unbounded<
          ThreadId | { readonly location?: string; readonly unsettledOnly?: boolean }
        >();
        const layerDependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromPubSub(events),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getPullRequestDiscoverySnapshot: (options) =>
              Queue.offer(
                reads,
                options.threadId ?? { unsettledOnly: options.unsettledOnly ?? false },
              ).pipe(
                Effect.as({
                  snapshotSequence: 1,
                  threads:
                    options.threadId === undefined
                      ? [thread, other]
                      : [thread, other].filter((candidate) => candidate.id === options.threadId),
                }),
              ),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () => Effect.succeed([]),
          }),
          Layer.mock(GitManager.GitManager)({}),
          Layer.mock(PullRequestService.PullRequestService)({}),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            Crypto.Crypto,
            Crypto.make({
              randomBytes: (size) => new Uint8Array(size).fill(1),
              digest: (_algorithm, data) => Effect.succeed(data),
            }),
          ),
          FileSystem.layerNoop({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);
          // Startup backfill reads every active thread.
          expect(yield* Queue.take(reads)).toEqual({ unsettledOnly: false });
          yield* service.drain;
          yield* PubSub.publish(events, {
            type: "thread.metadata-updated",
            id: EventId.make("event:metadata"),
            threadId: thread.id,
            occurredAt: NOW,
            payload: {
              createdBy: thread.createdBy,
              creationSource: thread.creationSource,
              id: thread.id,
              projectId: thread.projectId,
              title: thread.title,
              providerInstanceId: thread.providerInstanceId,
              modelSelection: thread.modelSelection,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              branch: thread.branch,
              worktreePath: thread.worktreePath,
              activeProviderThreadId: thread.activeProviderThreadId,
              lineage: thread.lineage,
              forkedFrom: null,
              createdAt: thread.createdAt,
              updatedAt: thread.updatedAt,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          });
          expect(yield* Queue.take(reads)).toBe(thread.id);
          yield* service.drain;
          expect(yield* Queue.size(reads)).toBe(0);
        }).pipe(Effect.provide(layerDependencies));
      }),
    ),
  );

  it.effect("periodic sweeps read only unsettled threads once backfill is done", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settled = {
          ...threadShell("settled-thread"),
          branch: "feature/settled",
          settledOverride: "settled" as const,
          settledAt: NOW,
        };
        const activation = yield* Deferred.make<void>();
        const reads = yield* Queue.unbounded<{
          readonly location?: string;
          readonly unsettledOnly?: boolean;
        }>();
        const layerDependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.never,
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getPullRequestDiscoverySnapshot: (options) =>
              Queue.offer(reads, options).pipe(
                Effect.as({ snapshotSequence: 1, threads: options.unsettledOnly ? [] : [settled] }),
              ),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () => Effect.succeed([]),
          }),
          Layer.mock(GitManager.GitManager)({}),
          Layer.mock(PullRequestService.PullRequestService)({}),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            Crypto.Crypto,
            Crypto.make({
              randomBytes: (size) => new Uint8Array(size).fill(1),
              digest: (_algorithm, data) => Effect.succeed(data),
            }),
          ),
          FileSystem.layerNoop({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);
          // Backfill finds the settled branch thread and must read it again.
          expect(yield* Queue.take(reads)).toEqual({ unsettledOnly: false });
          yield* service.drain;
          // Its project is gone, so backfill finishes it on the first pass.
          yield* TestClock.adjust("1 minute");
          expect(yield* Queue.take(reads)).toEqual({ unsettledOnly: true });
          yield* service.drain;
        }).pipe(Effect.provide(layerDependencies));
      }),
    ),
  );

  it.effect("coalesces queued events for one thread and preserves forced refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = { ...threadShell("coalesced"), branch: "feature/coalesced" };
        const activation = yield* Deferred.make<void>();
        const releaseStartup = yield* Deferred.make<void>();
        const releaseEvents = yield* Deferred.make<void>();
        const consumed = yield* Deferred.make<void>();
        const reads = yield* Queue.unbounded<void>();
        const lookups: boolean[] = [];
        let readCount = 0;
        const event = {
          type: "thread.unsettled",
          id: EventId.make("event:coalesced"),
          threadId: thread.id,
          occurredAt: NOW,
          payload: {
            id: thread.id,
            projectId: thread.projectId,
            title: thread.title,
            providerInstanceId: thread.providerInstanceId,
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            branch: thread.branch,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: thread.lineage,
            forkedFrom: null,
            createdBy: "user",
            creationSource: "web",
            createdAt: NOW,
            updatedAt: NOW,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        } satisfies OrchestrationV2DomainEvent;
        const identity = {
          canonicalKey: "github.com/owner/repo",
          provider: "github" as const,
          displayName: "owner/repo",
          owner: "owner",
          name: "repo",
          locator: {
            source: "git-remote" as const,
            remoteName: "origin",
            remoteUrl: "git@github.com:owner/repo.git",
          },
        };
        const project: OrchestrationProjectShell = {
          id: thread.projectId,
          title: "Project",
          workspaceRoot: "/workspace",
          defaultModelSelection: null,
          scripts: [],
          repositoryIdentity: identity,
          createdAt: "2026-09-01T00:00:00Z",
          updatedAt: "2026-09-01T00:00:00Z",
        };
        const dependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromEffect(Deferred.await(releaseEvents)).pipe(
              Stream.flatMap(() =>
                Stream.fromIterable([
                  event,
                  { ...event, type: "thread.metadata-updated" as const },
                  { ...event, type: "thread.metadata-updated" as const },
                ]),
              ),
              Stream.ensuring(Deferred.succeed(consumed, undefined)),
            ),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getPullRequestDiscoverySnapshot: () =>
              Effect.gen(function* () {
                readCount++;
                yield* Queue.offer(reads, undefined);
                if (readCount === 1) yield* Deferred.await(releaseStartup);
                return { snapshotSequence: 1, threads: [thread] };
              }),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([project]) }),
          Layer.mock(GitManager.GitManager)({
            branchPullRequest: (_input, options) =>
              Effect.sync(() => {
                lookups.push(options?.refresh ?? false);
                return null;
              }),
          }),
          Layer.mock(PullRequestService.PullRequestService)({}),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
            resolve: () => Effect.succeed(identity),
          }),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            Crypto.Crypto,
            Crypto.make({
              randomBytes: (size) => new Uint8Array(size).fill(1),
              digest: (_algorithm, data) => Effect.succeed(data),
            }),
          ),
          FileSystem.layerNoop({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);
          yield* Queue.take(reads);
          yield* Deferred.succeed(releaseEvents, undefined);
          yield* Deferred.await(consumed);
          yield* Deferred.succeed(releaseStartup, undefined);
          yield* service.drain;
          expect(readCount).toBe(2);
          expect(lookups).toEqual([false, true]);
        }).pipe(Effect.provide(dependencies));
      }),
    ),
  );

  it.effect("disabling discovery stops reads and re-enabling backfills settled threads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let enabled = false;
        const activation = yield* Deferred.make<void>();
        const checked = yield* Queue.unbounded<boolean>();
        const reads: boolean[] = [];
        const dependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.suspend(() =>
              Queue.offer(checked, enabled).pipe(
                Effect.as({ ...DEFAULT_SERVER_SETTINGS, autoDiscoverThreadPullRequests: enabled }),
              ),
            ),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getPullRequestDiscoverySnapshot: (options) =>
              Effect.sync(() => {
                reads.push(options.unsettledOnly ?? false);
                return { snapshotSequence: 1, threads: [] };
              }),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
          Layer.mock(GitManager.GitManager)({}),
          Layer.mock(PullRequestService.PullRequestService)({}),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            Crypto.Crypto,
            Crypto.make({
              randomBytes: (size) => new Uint8Array(size).fill(1),
              digest: (_algorithm, data) => Effect.succeed(data),
            }),
          ),
          FileSystem.layerNoop({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);
          expect(yield* Queue.take(checked)).toBe(false);
          yield* service.drain;
          expect(reads).toEqual([]);
          enabled = true;
          yield* TestClock.adjust("1 minute");
          expect(yield* Queue.take(checked)).toBe(true);
          yield* service.drain;
          expect(reads).toEqual([false]);
          yield* TestClock.adjust("1 minute");
          expect(yield* Queue.take(checked)).toBe(true);
          yield* service.drain;
          expect(reads).toEqual([false, true]);
          enabled = false;
          yield* TestClock.adjust("1 minute");
          expect(yield* Queue.take(checked)).toBe(false);
          yield* service.drain;
          expect(reads).toEqual([false, true]);
          enabled = true;
          yield* TestClock.adjust("1 minute");
          expect(yield* Queue.take(checked)).toBe(true);
          yield* service.drain;
          expect(reads).toEqual([false, true, false]);
        }).pipe(Effect.provide(dependencies));
      }),
    ),
  );
});
