import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type {
  GitManagerServiceError,
  VcsStatusInput,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusSubscriptionInput,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL } from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { mergeGitStatusParts } from "@t3tools/shared/git";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";

const BACKGROUND_REFRESH_MAX_WAIT_MS = 30_000;
const DEFAULT_VCS_STATUS_REFRESH_INTERVAL = Duration.seconds(30);
const VCS_STATUS_REFRESH_FAILURE_BASE_DELAY = Duration.seconds(30);
const VCS_STATUS_REFRESH_FAILURE_MAX_DELAY = Duration.minutes(15);
const VCS_STATUS_REFRESH_MAX_CONSECUTIVE_FAILURES = 3;
const MAX_FAILURE_DIAGNOSTIC_VALUES = 8;
const MAX_FAILURE_DIAGNOSTIC_VALUE_LENGTH = 128;

function boundedDiagnosticValue(value: string): string {
  return value.slice(0, MAX_FAILURE_DIAGNOSTIC_VALUE_LENGTH);
}

function diagnosticValueTag(value: unknown): string {
  try {
    if (
      typeof value === "object" &&
      value !== null &&
      "_tag" in value &&
      typeof value._tag === "string"
    ) {
      return boundedDiagnosticValue(value._tag);
    }
    if (value instanceof Error) {
      return boundedDiagnosticValue(value.name);
    }
    return typeof value;
  } catch {
    return "Uninspectable";
  }
}

function diagnosticFailureOperation(value: unknown): string | undefined {
  try {
    if (
      typeof value === "object" &&
      value !== null &&
      "operation" in value &&
      typeof value.operation === "string"
    ) {
      return boundedDiagnosticValue(value.operation);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function addUniqueDiagnosticValue(values: Array<string>, value: string | undefined): void {
  if (
    value !== undefined &&
    values.length < MAX_FAILURE_DIAGNOSTIC_VALUES &&
    !values.includes(value)
  ) {
    values.push(value);
  }
}

export function remoteRefreshFailureDiagnostics(cause: Cause.Cause<unknown>) {
  const failureTags: Array<string> = [];
  const failureOperations: Array<string> = [];
  const defectTags: Array<string> = [];
  let failureCount = 0;
  let defectCount = 0;
  let interruptionCount = 0;

  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      failureCount += 1;
      addUniqueDiagnosticValue(failureTags, diagnosticValueTag(reason.error));
      addUniqueDiagnosticValue(failureOperations, diagnosticFailureOperation(reason.error));
      continue;
    }
    if (Cause.isDieReason(reason)) {
      defectCount += 1;
      addUniqueDiagnosticValue(defectTags, diagnosticValueTag(reason.defect));
      continue;
    }
    interruptionCount += 1;
  }

  return {
    reasonCount: cause.reasons.length,
    failureCount,
    failureTags,
    failureOperations,
    defectCount,
    defectTags,
    interruptionCount,
  };
}

interface VcsStatusChange {
  readonly cwd: string;
  readonly event: VcsStatusStreamEvent;
  readonly preserveRemotePoller?: boolean;
}

interface CachedValue<T> {
  readonly fingerprint: string;
  readonly value: T;
}

interface CachedVcsStatus {
  readonly revision: number;
  readonly local: CachedValue<VcsStatusLocalResult> | null;
  readonly remote:
    | (CachedValue<VcsStatusRemoteResult | null> & {
        readonly remoteRefName: VcsStatusLocalResult["refName"];
        readonly remoteIsRepo: boolean;
      })
    | null;
}

interface CacheCommitResult {
  readonly committed: boolean;
  readonly shouldPublish: boolean;
}

interface RemoteCacheCommitResult {
  readonly committed: boolean;
  readonly localChanged: boolean;
  readonly remoteChanged: boolean;
}

interface ActiveRemotePoller {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly identity: string;
  readonly subscriberCount: number;
  readonly demandCwds: Ref.Ref<ReadonlyMap<string, number>>;
}

interface StreamStatusOptions {
  readonly automaticRemoteRefreshInterval?: Effect.Effect<Duration.Duration, never>;
  readonly automaticRemoteRefreshBeforeCommit?: Effect.Effect<void, never>;
}
export class VcsAutomaticFetchInterval extends Context.Reference<Effect.Effect<Duration.Duration>>(
  "t3/vcs/VcsAutomaticFetchInterval",
  { defaultValue: () => Effect.succeed(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL) },
) {}

export const layerAutomaticFetchInterval = Layer.effect(
  VcsAutomaticFetchInterval,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    return serverSettings.getSettings.pipe(
      Effect.map(
        (settings) => resolveServerBackgroundActivitySettings(settings).automaticGitFetchInterval,
      ),
      Effect.orElseSucceed(() => DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL),
    );
  }),
);

export class VcsAutoPullPolicy extends Context.Reference<{
  readonly isEnabled: (cwd: string) => Effect.Effect<boolean, never>;
}>("t3/vcs/VcsAutoPullPolicy", {
  defaultValue: () => ({ isEnabled: () => Effect.succeed(false) }),
}) {}

export const layerAutoPullPolicy = Layer.effect(
  VcsAutoPullPolicy,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    return {
      isEnabled: Effect.fn("VcsAutoPullPolicy.isEnabled")(
        function* (cwd: string) {
          const project = yield* projects.findActiveByWorkspaceRoot(cwd);
          if (project._tag === "None") return false;
          const settings = yield* serverSettings.getSettings;
          return resolveProjectSettings(settings, project.value.projectId).settings.defaultAutoPull;
        },
        Effect.orElseSucceed(() => false),
      ),
    };
  }),
);

export function remoteRefreshFailureDelay(
  consecutiveFailures: number,
  configuredInterval: Duration.Duration,
) {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const backoffMs =
    Duration.toMillis(VCS_STATUS_REFRESH_FAILURE_BASE_DELAY) * Math.pow(2, exponent);
  const cappedBackoff = Duration.min(
    Duration.millis(backoffMs),
    VCS_STATUS_REFRESH_FAILURE_MAX_DELAY,
  );
  return Duration.max(configuredInterval, cappedBackoff);
}

export class VcsStatusBroadcaster extends Context.Service<
  VcsStatusBroadcaster,
  {
    readonly getStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly refreshLocalStatus: (
      cwd: string,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly refreshStatus: (
      cwd: string,
      options?: { readonly localOnly?: boolean },
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly refreshStatusInBackground: (cwd: string) => Effect.Effect<void>;
    readonly refreshPullRequestStatus: (
      cwd: string,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    readonly streamStatus: (
      input: VcsStatusSubscriptionInput,
      options?: StreamStatusOptions,
    ) => Stream.Stream<VcsStatusStreamEvent, GitManagerServiceError>;
  }
>()("t3/vcs/VcsStatusBroadcaster") {}

function fingerprintStatusPart(status: unknown): string {
  return JSON.stringify(status);
}

const normalizeCwd = (cwd: string) =>
  Effect.service(FileSystem.FileSystem).pipe(
    Effect.flatMap((fs) => fs.realPath(cwd)),
    Effect.orElseSucceed(() => cwd),
  );

/** @public */
export const make = Effect.gen(function* () {
  const automaticFetchInterval = yield* VcsAutomaticFetchInterval;
  const autoPullPolicy = yield* VcsAutoPullPolicy;
  const workflow = yield* GitWorkflowService.GitWorkflowService;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const fs = yield* FileSystem.FileSystem;
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<VcsStatusChange>(),
    (pubsub) => PubSub.shutdown(pubsub),
  );
  const broadcasterScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const cacheRef = yield* Ref.make(new Map<string, CachedVcsStatus>());
  const pollersRef = yield* SynchronizedRef.make(new Map<string, ActiveRemotePoller>());

  const cacheCommitLock = yield* Semaphore.make(1);
  const remoteOperationLocksRef = yield* SynchronizedRef.make(
    new Map<string, Semaphore.Semaphore>(),
  );
  const emptyCachedStatus = (): CachedVcsStatus => ({ revision: 0, local: null, remote: null });

  const getCachedStatus = Effect.fn("VcsStatusBroadcaster.getCachedStatus")(function* (
    cwd: string,
  ) {
    return yield* Ref.get(cacheRef).pipe(Effect.map((cache) => cache.get(cwd) ?? null));
  });

  const getCompatibleCachedRemote = (
    local: VcsStatusLocalResult,
    cached: CachedVcsStatus | null,
  ) =>
    cached?.remote?.remoteRefName === local.refName && cached.remote.remoteIsRepo === local.isRepo
      ? cached.remote
      : null;

  const sameLocalIdentity = (left: VcsStatusLocalResult, right: VcsStatusLocalResult) =>
    left.isRepo === right.isRepo && left.refName === right.refName;

  const remotePollerIdentity = (local: VcsStatusLocalResult) =>
    local.isRepo ? fingerprintStatusPart({ isRepo: true, refName: local.refName }) : null;

  const getRemoteOperationLock = (cwd: string) =>
    SynchronizedRef.modifyEffect(remoteOperationLocksRef, (locks) => {
      const existing = locks.get(cwd);
      if (existing) {
        return Effect.succeed([existing, locks] as const);
      }
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(locks);
          next.set(cwd, semaphore);
          return [semaphore, next] as const;
        }),
      );
    });

  const withRemoteOperationLock = <A, E, R>(
    cwd: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.flatMap(getRemoteOperationLock(cwd), (lock) => lock.withPermit(effect));

  const observeRemoteStatusWithinLock = Effect.fn(
    "VcsStatusBroadcaster.observeRemoteStatusWithinLock",
  )(function* (
    cwd: string,
    options?: { readonly refreshUpstream?: boolean; readonly refreshMissingPullRequest?: boolean },
  ) {
    const expectedRevision = (yield* getCachedStatus(cwd))?.revision ?? 0;
    const localBefore = yield* workflow.localStatus({ cwd });
    const effectiveOptions = options ?? {
      refreshUpstream: !Duration.isZero(yield* automaticFetchInterval),
    };
    const remoteExit = yield* workflow.remoteStatus({ cwd }, effectiveOptions).pipe(Effect.exit);
    yield* workflow.invalidateLocalStatus(cwd);
    const localAfter = yield* workflow.localStatus({ cwd });
    if (!sameLocalIdentity(localBefore, localAfter)) {
      return { _tag: "unstable" as const, expectedRevision, local: localAfter } as const;
    }
    if (Exit.isFailure(remoteExit)) {
      return yield* Effect.failCause(remoteExit.cause);
    }
    return {
      _tag: "stable" as const,
      expectedRevision,
      local: localAfter,
      remote: remoteExit.value,
    } as const;
  });

  const makeSnapshotEvent = (
    local: VcsStatusLocalResult,
    cached: CachedVcsStatus | null,
  ): VcsStatusChange["event"] => {
    const compatibleRemote = getCompatibleCachedRemote(local, cached);
    if (compatibleRemote === null) {
      return {
        _tag: "snapshot",
        local,
        remote: null,
      };
    }
    return {
      _tag: "snapshot",
      local,
      remote: compatibleRemote.value,
      remoteRefName: compatibleRemote.remoteRefName,
    };
  };

  const updateCachedLocalStatus = Effect.fn("VcsStatusBroadcaster.updateCachedLocalStatus")(
    function* (
      cwd: string,
      local: VcsStatusLocalResult,
      options?: {
        publish?: boolean;
        preserveRemotePoller?: boolean;
        expectedRevision?: number;
      },
    ) {
      const nextLocal = {
        fingerprint: fingerprintStatusPart(local),
        value: local,
      } satisfies CachedValue<VcsStatusLocalResult>;
      return yield* cacheCommitLock.withPermit(
        Effect.gen(function* () {
          const result = yield* Ref.modify<Map<string, CachedVcsStatus>, CacheCommitResult>(
            cacheRef,
            (cache) => {
              const previous = cache.get(cwd) ?? emptyCachedStatus();
              if (
                options?.expectedRevision !== undefined &&
                previous.revision !== options.expectedRevision
              ) {
                return [{ committed: false, shouldPublish: false }, cache] as const;
              }
              const nextCache = new Map(cache);
              nextCache.set(cwd, {
                ...previous,
                revision: previous.revision + 1,
                local: nextLocal,
              });
              return [
                {
                  committed: true,
                  shouldPublish: previous.local?.fingerprint !== nextLocal.fingerprint,
                },
                nextCache,
              ] as const;
            },
          );

          if (options?.publish && result.shouldPublish) {
            yield* PubSub.publish(changesPubSub, {
              cwd,
              ...(options.preserveRemotePoller ? { preserveRemotePoller: true } : {}),
              event: {
                _tag: "localUpdated",
                local,
              },
            });
          }

          return result.committed;
        }),
      );
    },
  );

  const updateCachedRemoteStatus = Effect.fn("VcsStatusBroadcaster.updateCachedRemoteStatus")(
    function* (
      cwd: string,
      remote: VcsStatusRemoteResult | null,
      observedLocal: VcsStatusLocalResult,
      options: { expectedRevision: number; publish?: boolean },
    ) {
      const remoteRefName = observedLocal.refName;
      const nextLocal = {
        fingerprint: fingerprintStatusPart(observedLocal),
        value: observedLocal,
      } satisfies CachedValue<VcsStatusLocalResult>;
      const nextRemote = {
        fingerprint: fingerprintStatusPart(remote),
        value: remote,
        remoteRefName,
        remoteIsRepo: observedLocal.isRepo,
      };
      return yield* cacheCommitLock.withPermit(
        Effect.gen(function* () {
          const changes = yield* Ref.modify<Map<string, CachedVcsStatus>, RemoteCacheCommitResult>(
            cacheRef,
            (cache) => {
              const previous = cache.get(cwd) ?? emptyCachedStatus();
              if (previous.revision !== options.expectedRevision) {
                return [
                  { committed: false, localChanged: false, remoteChanged: false },
                  cache,
                ] as const;
              }
              const localChanged = previous.local?.fingerprint !== nextLocal.fingerprint;
              const remoteChanged =
                previous.remote?.fingerprint !== nextRemote.fingerprint ||
                previous.remote?.remoteRefName !== nextRemote.remoteRefName ||
                previous.remote?.remoteIsRepo !== nextRemote.remoteIsRepo;
              const nextCache = new Map(cache);
              nextCache.set(cwd, {
                revision: previous.revision + 1,
                local: nextLocal,
                remote: nextRemote,
              });
              return [{ committed: true, localChanged, remoteChanged }, nextCache] as const;
            },
          );

          if (
            options.publish &&
            changes.committed &&
            (changes.localChanged || !observedLocal.isRepo)
          ) {
            const event = {
              _tag: "snapshot" as const,
              local: observedLocal,
              remote,
              remoteRefName,
            };
            yield* PubSub.publish(changesPubSub, { cwd, event });
          } else if (options.publish && changes.committed && changes.remoteChanged) {
            const event = { _tag: "remoteUpdated" as const, remote, remoteRefName };
            yield* PubSub.publish(changesPubSub, { cwd, event });
          }

          return changes.committed;
        }),
      );
    },
  );

  const updateCachedStatus = Effect.fn("VcsStatusBroadcaster.updateCachedStatus")(function* (
    cwd: string,
    local: VcsStatusLocalResult,
    remote: VcsStatusRemoteResult | null,
    options: { expectedRevision: number; publish?: boolean },
  ) {
    const remoteRefName = local.refName;
    const nextLocal = {
      fingerprint: fingerprintStatusPart(local),
      value: local,
    } satisfies CachedValue<VcsStatusLocalResult>;
    const nextRemote = {
      fingerprint: fingerprintStatusPart(remote),
      value: remote,
      remoteRefName,
      remoteIsRepo: local.isRepo,
    };
    return yield* cacheCommitLock.withPermit(
      Effect.gen(function* () {
        const result = yield* Ref.modify<Map<string, CachedVcsStatus>, CacheCommitResult>(
          cacheRef,
          (cache) => {
            const previous = cache.get(cwd) ?? emptyCachedStatus();
            if (previous.revision !== options.expectedRevision) {
              return [{ committed: false, shouldPublish: false }, cache] as const;
            }
            const nextCache = new Map(cache);
            nextCache.set(cwd, {
              revision: previous.revision + 1,
              local: nextLocal,
              remote: nextRemote,
            });
            return [
              {
                committed: true,
                shouldPublish:
                  previous.local?.fingerprint !== nextLocal.fingerprint ||
                  previous.remote?.fingerprint !== nextRemote.fingerprint ||
                  previous.remote?.remoteRefName !== nextRemote.remoteRefName ||
                  previous.remote?.remoteIsRepo !== nextRemote.remoteIsRepo,
              },
              nextCache,
            ] as const;
          },
        );

        if (options.publish && result.committed && result.shouldPublish) {
          const event = {
            _tag: "snapshot" as const,
            local,
            remote,
            remoteRefName,
          };
          yield* PubSub.publish(changesPubSub, { cwd, event });
        }

        return result.committed ? mergeGitStatusParts(local, remote) : null;
      }),
    );
  });

  const loadLocalStatus = Effect.fn("VcsStatusBroadcaster.loadLocalStatus")(function* (
    cwd: string,
  ) {
    const local = yield* workflow.localStatus({ cwd });
    yield* updateCachedLocalStatus(cwd, local);
    return local;
  });

  const getOrLoadLocalStatus = Effect.fn("VcsStatusBroadcaster.getOrLoadLocalStatus")(function* (
    cwd: string,
  ) {
    const cached = yield* getCachedStatus(cwd);
    if (cached?.local) {
      return cached.local.value;
    }
    return yield* loadLocalStatus(cwd);
  });

  const withFileSystem = Effect.provideService(FileSystem.FileSystem, fs);

  const getStatus: VcsStatusBroadcaster["Service"]["getStatus"] = Effect.fn(
    "VcsStatusBroadcaster.getStatus",
  )(function* (input) {
    const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
    const cached = yield* getCachedStatus(cwd);
    if (cached?.local) {
      const compatibleRemote = getCompatibleCachedRemote(cached.local.value, cached);
      if (compatibleRemote !== null) {
        return mergeGitStatusParts(cached.local.value, compatibleRemote.value);
      }
    }

    return yield* withRemoteOperationLock(
      cwd,
      Effect.gen(function* () {
        const lockedCached = yield* getCachedStatus(cwd);
        let observeOptions: { readonly refreshUpstream?: boolean } | undefined;
        if (lockedCached?.local) {
          const compatibleRemote = getCompatibleCachedRemote(
            lockedCached.local.value,
            lockedCached,
          );
          if (compatibleRemote !== null) {
            return mergeGitStatusParts(lockedCached.local.value, compatibleRemote.value);
          }
          observeOptions = { refreshUpstream: false };
        }

        const observed = yield* observeRemoteStatusWithinLock(cwd, observeOptions);
        if (observed._tag === "unstable") {
          const committed = yield* updateCachedLocalStatus(cwd, observed.local, {
            expectedRevision: observed.expectedRevision,
            publish: true,
            preserveRemotePoller: !observed.local.isRepo,
          });
          if (committed) {
            return mergeGitStatusParts(observed.local, null);
          }
          const current = yield* getCachedStatus(cwd);
          const currentLocal = current?.local?.value ?? observed.local;
          return mergeGitStatusParts(
            currentLocal,
            getCompatibleCachedRemote(currentLocal, current)?.value ?? null,
          );
        }
        const committed = yield* updateCachedStatus(cwd, observed.local, observed.remote, {
          expectedRevision: observed.expectedRevision,
        });
        if (committed !== null) {
          return committed;
        }
        const current = yield* getCachedStatus(cwd);
        const currentLocal = current?.local?.value ?? observed.local;
        return mergeGitStatusParts(
          currentLocal,
          getCompatibleCachedRemote(currentLocal, current)?.value ?? null,
        );
      }),
    );
  });

  const refreshLocalStatusCore = Effect.fn("VcsStatusBroadcaster.refreshLocalStatusCore")(
    function* (cwd: string) {
      yield* workflow.invalidateLocalStatus(cwd);
      const local = yield* workflow.localStatus({ cwd });
      yield* updateCachedLocalStatus(cwd, local, { publish: true });
      return local;
    },
  );

  const maybeAutoPull = Effect.fn("VcsStatusBroadcaster.maybeAutoPull")(function* (
    cwd: string,
    remote: VcsStatusRemoteResult | null,
    policyCwds: ReadonlyArray<string>,
  ) {
    let pullAttempted = false;
    let expectedRevision = 0;
    return yield* Effect.gen(function* () {
      const autoPullEnabled = (yield* Effect.forEach(policyCwds, autoPullPolicy.isEnabled, {
        concurrency: "unbounded",
      })).some(Boolean);
      if (
        remote === null ||
        !remote.hasUpstream ||
        remote.aheadCount > 0 ||
        remote.behindCount <= 0 ||
        !autoPullEnabled
      ) {
        return null;
      }

      yield* workflow.invalidateLocalStatus(cwd);
      const local = yield* workflow.localStatus({ cwd });
      if (!local.isRepo || !local.isDefaultRef || local.hasWorkingTreeChanges) return null;

      expectedRevision = (yield* getCachedStatus(cwd))?.revision ?? 0;
      pullAttempted = true;
      yield* workflow.pullCurrentBranch(cwd);
      yield* workflow.invalidateStatus(cwd);
      const [refreshedLocal, refreshedRemote] = yield* Effect.all(
        [workflow.localStatus({ cwd }), workflow.remoteStatus({ cwd }, { refreshUpstream: false })],
        { concurrency: "unbounded" },
      );
      yield* updateCachedStatus(cwd, refreshedLocal, refreshedRemote, {
        publish: true,
        expectedRevision,
      });
      return { local: refreshedLocal, remote: refreshedRemote };
    }).pipe(
      Effect.catch(
        Effect.fn("VcsStatusBroadcaster.maybeAutoPull")(function* (error) {
          yield* Effect.logWarning("Automatic project pull failed", {
            cwdLength: cwd.length,
            errorTag: error._tag,
          });
          if (!pullAttempted) return null;
          // Pull can change local state before failing; propagate reconciliation failures instead of publishing stale status.
          yield* workflow.invalidateLocalStatus(cwd);
          const local = yield* workflow.localStatus({ cwd });
          yield* updateCachedStatus(cwd, local, remote, { publish: true, expectedRevision });
          return { local, remote };
        }),
      ),
    );
  });

  const refreshRemoteStatus = Effect.fn("VcsStatusBroadcaster.refreshRemoteStatus")(function* (
    cwd: string,
    options?: {
      readonly refreshUpstream?: boolean;
      readonly beforeCommit?: Effect.Effect<void, never>;
      readonly policyCwds?: ReadonlyArray<string>;
    },
  ) {
    return yield* withRemoteOperationLock(
      cwd,
      Effect.gen(function* () {
        if (options?.refreshUpstream !== false) {
          yield* workflow.invalidateRemoteStatus(cwd);
        }
        const observed = yield* observeRemoteStatusWithinLock(cwd, options);
        yield* options?.beforeCommit ?? Effect.void;
        if (observed._tag === "unstable") {
          yield* updateCachedLocalStatus(cwd, observed.local, {
            expectedRevision: observed.expectedRevision,
            publish: true,
            preserveRemotePoller: !observed.local.isRepo,
          });
          return { _tag: "unstable" as const };
        }
        const pulled =
          options?.refreshUpstream === false
            ? null
            : yield* maybeAutoPull(cwd, observed.remote, options?.policyCwds ?? [cwd]);
        if (pulled !== null) return { _tag: "stable" as const, remote: pulled.remote };
        const committed = yield* updateCachedRemoteStatus(cwd, observed.remote, observed.local, {
          expectedRevision: observed.expectedRevision,
          publish: true,
        });
        return committed
          ? ({ _tag: "stable" as const, remote: observed.remote } as const)
          : ({ _tag: "unstable" as const } as const);
      }),
    );
  });

  const refreshStatusCore = Effect.fn("VcsStatusBroadcaster.refreshStatusCore")(function* (
    cwd: string,
    rawCwd: string,
    shouldRun: Effect.Effect<boolean>,
  ) {
    return yield* withRemoteOperationLock(
      cwd,
      Effect.gen(function* () {
        if (!(yield* shouldRun)) return undefined;
        // invalidateStatus (not the two partial invalidations) so an explicit
        // refresh also bypasses GitManager's slow PR-lookup cache.
        yield* workflow.invalidateStatus(cwd);
        const observed = yield* observeRemoteStatusWithinLock(cwd);
        if (observed._tag === "unstable") {
          const committed = yield* updateCachedLocalStatus(cwd, observed.local, {
            expectedRevision: observed.expectedRevision,
            publish: true,
            preserveRemotePoller: !observed.local.isRepo,
          });
          if (committed) {
            return mergeGitStatusParts(observed.local, null);
          }
          const current = yield* getCachedStatus(cwd);
          const currentLocal = current?.local?.value ?? observed.local;
          return mergeGitStatusParts(
            currentLocal,
            getCompatibleCachedRemote(currentLocal, current)?.value ?? null,
          );
        }
        const pulled = Duration.isZero(yield* automaticFetchInterval)
          ? null
          : yield* maybeAutoPull(cwd, observed.remote, [rawCwd]);
        if (pulled !== null) return mergeGitStatusParts(pulled.local, pulled.remote);
        const committed = yield* updateCachedStatus(cwd, observed.local, observed.remote, {
          expectedRevision: observed.expectedRevision,
          publish: true,
        });
        if (committed !== null) {
          return committed;
        }
        const current = yield* getCachedStatus(cwd);
        const currentLocal = current?.local?.value ?? observed.local;
        return mergeGitStatusParts(
          currentLocal,
          getCompatibleCachedRemote(currentLocal, current)?.value ?? null,
        );
      }),
    );
  });

  // Each refresh kind owns one running check and one follow-up per canonical workspace.
  // Callers arriving during a check need its follow-up to observe their changes.
  const makeRefreshLane = <A>(
    run: (
      cwd: string,
      rawCwd: string,
      shouldRun: Effect.Effect<boolean>,
    ) => Effect.Effect<A | undefined, GitManagerServiceError>,
  ) => {
    interface RefreshBatch {
      rawCwd: string;
      readonly result: Deferred.Deferred<A, GitManagerServiceError>;
      foregroundWaiters: number;
      backgroundRequestedAt: number | null;
    }
    interface RefreshLane {
      current: RefreshBatch;
      pending: RefreshBatch | null;
    }
    const refreshLanes = new Map<string, RefreshLane>();

    const drainRefreshLane = (cwd: string, lane: RefreshLane) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          while (true) {
            const batch = lane.current;
            // Recheck inside the Git operation lock: its queue time counts toward freshness.
            const shouldRun = Clock.currentTimeMillis.pipe(
              Effect.map(
                (now) =>
                  batch.foregroundWaiters > 0 ||
                  (batch.backgroundRequestedAt !== null &&
                    now - batch.backgroundRequestedAt <= BACKGROUND_REFRESH_MAX_WAIT_MS),
              ),
            );
            const exit = yield* restore(run(cwd, batch.rawCwd, shouldRun)).pipe(Effect.exit);
            if (Exit.isFailure(exit)) {
              yield* Deferred.done(batch.result, Exit.failCause(exit.cause));
              if (Cause.hasInterrupts(exit.cause)) {
                if (lane.pending)
                  yield* Deferred.done(lane.pending.result, Exit.failCause(exit.cause));
                return;
              }
              if (batch.foregroundWaiters === 0) {
                yield* Effect.logWarning("VCS background status refresh failed", {
                  ...remoteRefreshFailureDiagnostics(exit.cause),
                });
              }
            } else if (exit.value !== undefined) {
              yield* Deferred.succeed(batch.result, exit.value);
            }
            const hasNext = yield* Effect.sync(() => {
              if (lane.pending === null) {
                refreshLanes.delete(cwd);
                return false;
              }
              lane.current = lane.pending;
              lane.pending = null;
              return true;
            });
            if (!hasNext) return;
          }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (refreshLanes.get(cwd) === lane) refreshLanes.delete(cwd);
            }),
          ),
        ),
      );

    const enqueueRefresh = (
      cwd: string,
      rawCwd: string,
      background: boolean,
      requestedAt?: number,
    ) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const existing = refreshLanes.get(cwd);
          const batch = existing?.pending ?? {
            rawCwd,
            result: Deferred.makeUnsafe<A, GitManagerServiceError>(),
            foregroundWaiters: 0,
            backgroundRequestedAt: null,
          };
          batch.rawCwd = rawCwd;
          if (background) {
            batch.backgroundRequestedAt = Math.max(
              batch.backgroundRequestedAt ?? 0,
              requestedAt ?? now,
            );
          } else batch.foregroundWaiters += 1;
          if (existing) {
            existing.pending = batch;
          } else {
            const lane = { current: batch, pending: null };
            refreshLanes.set(cwd, lane);
            yield* drainRefreshLane(cwd, lane).pipe(
              Effect.interruptible,
              Effect.forkIn(broadcasterScope),
            );
          }
          return batch;
        }),
      );

    const refresh = Effect.fn("refresh")(function* (rawCwd: string) {
      const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
      return yield* Effect.acquireUseRelease(
        enqueueRefresh(cwd, rawCwd, false),
        (batch) => Deferred.await(batch.result),
        (batch) =>
          Effect.sync(() => {
            batch.foregroundWaiters -= 1;
          }),
      );
    });

    const refreshInBackground = Effect.fn("refreshInBackground")(function* (rawCwd: string) {
      const requestedAt = yield* Clock.currentTimeMillis;
      // Path resolution can itself wait on a remote filesystem. Git actions must not await it.
      yield* Effect.gen(function* () {
        const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
        yield* enqueueRefresh(cwd, rawCwd, true, requestedAt);
      }).pipe(Effect.interruptible, Effect.forkIn(broadcasterScope, { startImmediately: true }));
    });

    return { refresh, refreshInBackground };
  };

  const fullRefresh = makeRefreshLane(refreshStatusCore);
  const refreshStatus: VcsStatusBroadcaster["Service"]["refreshStatus"] = (rawCwd, options) =>
    options?.localOnly
      ? Effect.gen(function* () {
          const local = yield* localRefresh.refresh(rawCwd);
          const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
          const cache = yield* getCachedStatus(cwd);
          return mergeGitStatusParts(local, getCompatibleCachedRemote(local, cache)?.value ?? null);
        })
      : fullRefresh.refresh(rawCwd);
  const refreshStatusInBackground = Effect.fn("VcsStatusBroadcaster.refreshStatusInBackground")(
    fullRefresh.refreshInBackground,
  );
  const localRefresh = makeRefreshLane<VcsStatusLocalResult>((cwd, _rawCwd, shouldRun) =>
    Effect.gen(function* () {
      if (!(yield* shouldRun)) return undefined;
      return yield* refreshLocalStatusCore(cwd);
    }),
  );
  const refreshLocalStatus = Effect.fn("VcsStatusBroadcaster.refreshLocalStatus")(
    localRefresh.refresh,
  );

  const pullRequestRefresh = makeRefreshLane<VcsStatusRemoteResult | null>(
    (cwd, rawCwd, shouldRun) =>
      withRemoteOperationLock(
        cwd,
        Effect.gen(function* () {
          if (!(yield* shouldRun)) return undefined;
          const cached = yield* getCachedStatus(cwd);
          if (cached?.remote?.value == null) return null;
          const poller = (yield* SynchronizedRef.get(pollersRef)).get(cwd);
          const demandCwds = poller ? [...(yield* Ref.get(poller.demandCwds)).keys()] : [rawCwd];
          const shouldRefresh = (yield* Effect.forEach(
            demandCwds,
            (demandCwd) =>
              backgroundPolicy.shouldRunScopeWork({ type: "vcs-status", cwd: demandCwd }),
            { concurrency: "unbounded" },
          )).some(Boolean);
          if (!shouldRefresh) return null;
          const observed = yield* observeRemoteStatusWithinLock(cwd, {
            refreshUpstream: false,
            refreshMissingPullRequest: true,
          });
          if (observed._tag === "unstable") {
            yield* updateCachedLocalStatus(cwd, observed.local, {
              publish: true,
              expectedRevision: observed.expectedRevision,
            });
            return null;
          }
          const committed = yield* updateCachedRemoteStatus(cwd, observed.remote, observed.local, {
            publish: true,
            expectedRevision: observed.expectedRevision,
          });
          return committed ? observed.remote : null;
        }),
      ),
  );
  const refreshPullRequestStatus = Effect.fn("VcsStatusBroadcaster.refreshPullRequestStatus")(
    pullRequestRefresh.refresh,
  );

  // A subscription owns this loop; keep each poll's spans out of a never-ending parent span.
  const makeRemoteRefreshLoop = Effect.fnUntraced(function* (
    cwd: string,
    demandCwdsRef: Ref.Ref<ReadonlyMap<string, number>>,
    automaticRemoteRefreshInterval: Effect.Effect<Duration.Duration, never>,
    automaticRemoteRefreshBeforeCommit: Effect.Effect<void, never>,
    refreshImmediately: boolean,
  ) {
    const consecutiveFailuresRef = yield* Ref.make(0);
    const needsInitialRefreshRef = yield* Ref.make(refreshImmediately);
    const refreshRemoteStatusIfEnabled = Effect.gen(function* () {
      const configuredInterval = yield* automaticRemoteRefreshInterval;
      const activeInterval = Duration.isZero(configuredInterval)
        ? DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL
        : configuredInterval;
      const needsInitialRefresh = yield* Ref.get(needsInitialRefreshRef);
      if (Duration.isZero(configuredInterval) && !needsInitialRefresh) {
        return activeInterval;
      }

      const demandCwds = yield* Ref.get(demandCwdsRef);
      const shouldRun =
        needsInitialRefresh ||
        (yield* Effect.forEach(
          [...demandCwds.keys()],
          (demandCwd) =>
            backgroundPolicy.shouldRunScopeWork({
              type: "vcs-status",
              cwd: demandCwd,
            }),
          { concurrency: "unbounded" },
        )).some(Boolean);
      if (!shouldRun) {
        return activeInterval;
      }

      const exit = yield* refreshRemoteStatus(cwd, {
        refreshUpstream: !Duration.isZero(configuredInterval),
        beforeCommit: automaticRemoteRefreshBeforeCommit,
        policyCwds: [...demandCwds.keys()],
      }).pipe(Effect.exit);
      if (Exit.isSuccess(exit)) {
        yield* Ref.set(consecutiveFailuresRef, 0);
        if (exit.value._tag === "unstable") {
          return activeInterval;
        }
        yield* Ref.set(needsInitialRefreshRef, false);
        return exit.value.remote === null ? null : activeInterval;
      }

      const interruptionReasons = exit.cause.reasons.filter(Cause.isInterruptReason);
      if (interruptionReasons.length > 0) {
        return yield* Effect.failCause(Cause.fromReasons<never>(interruptionReasons));
      }

      const consecutiveFailures = yield* Ref.updateAndGet(
        consecutiveFailuresRef,
        (count) => count + 1,
      );
      const nextDelay = remoteRefreshFailureDelay(consecutiveFailures, activeInterval);
      yield* Effect.logWarning("VCS remote status refresh failed", {
        cwdLength: cwd.length,
        ...remoteRefreshFailureDiagnostics(exit.cause),
        consecutiveFailures,
        nextDelayMs: Duration.toMillis(nextDelay),
      });
      return consecutiveFailures >= VCS_STATUS_REFRESH_MAX_CONSECUTIVE_FAILURES ? null : nextDelay;
    });

    if (!refreshImmediately) {
      const configuredInterval = yield* automaticRemoteRefreshInterval;
      yield* Effect.sleep(
        Duration.isZero(configuredInterval)
          ? DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL
          : configuredInterval,
      );
    }

    while (true) {
      const nextDelay = yield* refreshRemoteStatusIfEnabled;
      if (nextDelay === null) {
        return;
      }
      yield* Effect.sleep(nextDelay);
    }
  });

  const retainRemotePoller = Effect.fn("VcsStatusBroadcaster.retainRemotePoller")(function* (
    cwd: string,
    demandCwd: string,
    identity: string,
    automaticRemoteRefreshInterval: Effect.Effect<Duration.Duration, never>,
    automaticRemoteRefreshBeforeCommit: Effect.Effect<void, never>,
    refreshImmediately: boolean,
  ) {
    yield* SynchronizedRef.modifyEffect(pollersRef, (activePollers) => {
      const existing = activePollers.get(cwd);
      if (existing) {
        return Ref.update(existing.demandCwds, (demandCwds) => {
          const next = new Map(demandCwds);
          next.set(demandCwd, (next.get(demandCwd) ?? 0) + 1);
          return next;
        }).pipe(
          Effect.flatMap(() =>
            existing.identity === identity
              ? Effect.succeed(existing.fiber)
              : Fiber.interrupt(existing.fiber).pipe(
                  Effect.ignore,
                  Effect.andThen(
                    makeRemoteRefreshLoop(
                      cwd,
                      existing.demandCwds,
                      automaticRemoteRefreshInterval,
                      automaticRemoteRefreshBeforeCommit,
                      true,
                    ).pipe(Effect.forkIn(broadcasterScope)),
                  ),
                ),
          ),
          Effect.map((fiber) => {
            const nextPollers = new Map(activePollers);
            nextPollers.set(cwd, {
              ...existing,
              fiber,
              identity,
              subscriberCount: existing.subscriberCount + 1,
            });
            return [undefined, nextPollers] as const;
          }),
        );
      }

      return Ref.make<ReadonlyMap<string, number>>(new Map([[demandCwd, 1]])).pipe(
        Effect.flatMap((demandCwds) =>
          makeRemoteRefreshLoop(
            cwd,
            demandCwds,
            automaticRemoteRefreshInterval,
            automaticRemoteRefreshBeforeCommit,
            refreshImmediately,
          ).pipe(
            Effect.forkIn(broadcasterScope),
            Effect.map((fiber) => {
              const nextPollers = new Map(activePollers);
              nextPollers.set(cwd, {
                fiber,
                identity,
                subscriberCount: 1,
                demandCwds,
              });
              return [undefined, nextPollers] as const;
            }),
          ),
        ),
      );
    });
  });

  const rearmRemotePoller = Effect.fn("VcsStatusBroadcaster.rearmRemotePoller")(function* (
    cwd: string,
    demandCwd: string,
    identity: string,
    automaticRemoteRefreshInterval: Effect.Effect<Duration.Duration, never>,
    automaticRemoteRefreshBeforeCommit: Effect.Effect<void, never>,
  ) {
    yield* SynchronizedRef.modifyEffect(pollersRef, (activePollers) => {
      const existing = activePollers.get(cwd);
      if (!existing) {
        return Ref.make<ReadonlyMap<string, number>>(new Map([[demandCwd, 1]])).pipe(
          Effect.flatMap((demandCwds) =>
            makeRemoteRefreshLoop(
              cwd,
              demandCwds,
              automaticRemoteRefreshInterval,
              automaticRemoteRefreshBeforeCommit,
              true,
            ).pipe(
              Effect.forkIn(broadcasterScope),
              Effect.map((fiber) => {
                const nextPollers = new Map(activePollers);
                nextPollers.set(cwd, {
                  fiber,
                  identity,
                  subscriberCount: 1,
                  demandCwds,
                });
                return [undefined, nextPollers] as const;
              }),
            ),
          ),
        );
      }
      if (existing.identity === identity) {
        return Effect.succeed([undefined, activePollers] as const);
      }
      return Fiber.interrupt(existing.fiber).pipe(
        Effect.ignore,
        Effect.andThen(
          makeRemoteRefreshLoop(
            cwd,
            existing.demandCwds,
            automaticRemoteRefreshInterval,
            automaticRemoteRefreshBeforeCommit,
            true,
          ).pipe(Effect.forkIn(broadcasterScope)),
        ),
        Effect.map((fiber) => {
          const nextPollers = new Map(activePollers);
          nextPollers.set(cwd, { ...existing, fiber, identity });
          return [undefined, nextPollers] as const;
        }),
      );
    });
  });

  const releaseRemotePoller = Effect.fn("VcsStatusBroadcaster.releaseRemotePoller")(function* (
    cwd: string,
    demandCwd: string,
  ) {
    const pollerToInterrupt = yield* SynchronizedRef.modifyEffect(pollersRef, (activePollers) => {
      const existing = activePollers.get(cwd);
      if (!existing) {
        return Effect.succeed([null, activePollers] as const);
      }

      if (existing.subscriberCount > 1) {
        return Ref.update(existing.demandCwds, (demandCwds) => {
          const nextDemandCwds = new Map(demandCwds);
          const count = nextDemandCwds.get(demandCwd) ?? 0;
          if (count <= 1) {
            nextDemandCwds.delete(demandCwd);
          } else {
            nextDemandCwds.set(demandCwd, count - 1);
          }
          return nextDemandCwds;
        }).pipe(
          Effect.as([
            null,
            new Map(activePollers).set(cwd, {
              ...existing,
              subscriberCount: existing.subscriberCount - 1,
            }),
          ] as const),
        );
      }

      return Effect.succeed([
        existing.fiber,
        new Map([...activePollers].filter(([activeCwd]) => activeCwd !== cwd)),
      ] as const);
    });

    if (pollerToInterrupt) {
      yield* Fiber.interrupt(pollerToInterrupt).pipe(Effect.ignore);
    }
  });

  const streamStatus: VcsStatusBroadcaster["Service"]["streamStatus"] = (input, options) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
        const subscription = yield* PubSub.subscribe(changesPubSub);
        const initialLocal = yield* getOrLoadLocalStatus(cwd);
        const cachedStatus = yield* getCachedStatus(cwd);
        const hasDemandClass = "includeRemote" in input;
        const includeRemote = !hasDemandClass || input.includeRemote !== false;
        const automaticRemoteRefreshInterval =
          options?.automaticRemoteRefreshInterval ?? automaticFetchInterval;
        const automaticRemoteRefreshBeforeCommit =
          options?.automaticRemoteRefreshBeforeCommit ?? Effect.void;
        const remotePollerIdentityRef = yield* Effect.acquireRelease(
          Ref.make<string | null>(null),
          (identityRef) =>
            Ref.get(identityRef).pipe(
              Effect.flatMap((retainedIdentity) =>
                retainedIdentity !== null
                  ? releaseRemotePoller(cwd, input.cwd).pipe(Effect.ignore)
                  : Effect.void,
              ),
              Effect.uninterruptible,
              Effect.asVoid,
            ),
        );

        const syncRemotePollerRetention = Effect.fn(
          "VcsStatusBroadcaster.syncRemotePollerRetention",
        )(function* (local: VcsStatusLocalResult) {
          if (!includeRemote) {
            return;
          }
          const retainedIdentity = yield* Ref.get(remotePollerIdentityRef);
          const nextIdentity = remotePollerIdentity(local);
          if (retainedIdentity === nextIdentity) {
            return;
          }
          if (nextIdentity !== null && retainedIdentity === null) {
            const currentCache = yield* getCachedStatus(cwd);
            yield* retainRemotePoller(
              cwd,
              input.cwd,
              nextIdentity,
              automaticRemoteRefreshInterval,
              automaticRemoteRefreshBeforeCommit,
              getCompatibleCachedRemote(local, currentCache) === null,
            );
            yield* Ref.set(remotePollerIdentityRef, nextIdentity);
            return;
          }
          if (nextIdentity !== null) {
            yield* rearmRemotePoller(
              cwd,
              input.cwd,
              nextIdentity,
              automaticRemoteRefreshInterval,
              automaticRemoteRefreshBeforeCommit,
            );
            yield* Ref.set(remotePollerIdentityRef, nextIdentity);
            return;
          }
          yield* releaseRemotePoller(cwd, input.cwd).pipe(Effect.ignore);
          yield* Ref.set(remotePollerIdentityRef, null);
        }, Effect.uninterruptible);

        yield* syncRemotePollerRetention(initialLocal);

        const toStreamEvent = (event: VcsStatusChange["event"]): VcsStatusStreamEvent => {
          if (hasDemandClass || !("remoteRefName" in event)) {
            return event;
          }
          const { remoteRefName: _remoteRefName, ...legacyEvent } = event;
          return legacyEvent;
        };

        return Stream.concat(
          Stream.make(toStreamEvent(makeSnapshotEvent(initialLocal, cachedStatus))),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((event) => event.cwd === cwd),
            Stream.mapEffect((change) => {
              if (change.preserveRemotePoller) {
                return Effect.succeed(change);
              }
              const event = change.event;
              return event._tag === "snapshot" || event._tag === "localUpdated"
                ? syncRemotePollerRetention(event.local).pipe(Effect.as(change))
                : Effect.succeed(change);
            }),
            Stream.filterEffect(({ event }) => {
              if (event._tag !== "remoteUpdated" || !("remoteRefName" in event)) {
                return Effect.succeed(true);
              }
              return getCachedStatus(cwd).pipe(
                Effect.map((current) => {
                  const currentLocal = current?.local?.value;
                  return (
                    currentLocal !== undefined &&
                    currentLocal.refName === event.remoteRefName &&
                    current?.remote?.remoteIsRepo === currentLocal.isRepo
                  );
                }),
              );
            }),
            Stream.map((event) => toStreamEvent(event.event)),
          ),
        );
      }),
    );

  return VcsStatusBroadcaster.of({
    getStatus,
    refreshLocalStatus,
    refreshStatus,
    refreshStatusInBackground,
    refreshPullRequestStatus,
    streamStatus,
  });
});

export const layer = Layer.effect(VcsStatusBroadcaster, make);
