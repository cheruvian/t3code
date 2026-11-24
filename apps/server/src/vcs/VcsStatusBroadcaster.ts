// @effect-diagnostics-next-line nodeBuiltinImport:off -- A synchronous digest of the ref snapshot already in memory.
import * as NodeCrypto from "node:crypto";
import * as Schedule from "effect/Schedule";
import * as Path from "effect/Path";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
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
  VcsBranchStatus,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsRefreshStatusResult,
  VcsStatusSubscriptionInput,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL } from "@t3tools/contracts";

import { mergeGitStatusParts } from "@t3tools/shared/git";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";

const BACKGROUND_REFRESH_MAX_WAIT_MS = 30_000;

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

interface CachedRemoteStatus extends CachedValue<VcsStatusRemoteResult | null> {
  readonly branch: string | null;
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
export {
  VcsAutomaticFetchInterval,
  layer as layerAutomaticFetchInterval,
} from "./VcsAutomaticFetchInterval.ts";
import { VcsAutomaticFetchInterval } from "./VcsAutomaticFetchInterval.ts";

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
    readonly refreshBranchStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsBranchStatus, GitManagerServiceError>;
    readonly streamBranchStatus: (
      input: VcsStatusInput,
    ) => Stream.Stream<VcsBranchStatus, GitManagerServiceError>;
    readonly refreshAfterCheckout: (cwd: string) => Effect.Effect<void>;
    readonly streamBranchChanges: Stream.Stream<{
      readonly cwd: string;
      readonly refName: string | null;
    }>;
    readonly getStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly refreshLocalStatus: (
      cwd: string,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly refreshStatus: (
      cwd: string,
      options?: { readonly localOnly?: boolean },
    ) => Effect.Effect<VcsRefreshStatusResult, GitManagerServiceError>;
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
  const path = yield* Path.Path;
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<VcsStatusChange>(),
    (pubsub) => PubSub.shutdown(pubsub),
  );
  const broadcasterScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const branchChangesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<{
      readonly cwd: string;
      readonly refName: string | null;
      readonly isRepo: boolean;
      readonly revision: number;
    }>(),
    (pubsub) => PubSub.shutdown(pubsub),
  );
  const branches = new Map<
    string,
    VcsBranchStatus & { readonly revision: number; readonly observation: number }
  >();
  let branchObservation = 0;
  const detailedSubscribers = new Map<string, number>();
  const branchChangesDemand = new Map<string, number>();
  const branchChangesRead = new Map<string, boolean>();
  const wantsBranchChanges = (cwd: string) => branchChangesDemand.has(cwd);
  const acquireBranchChangesDemand = (cwd: string) =>
    Effect.acquireRelease(
      Effect.sync(() => branchChangesDemand.set(cwd, (branchChangesDemand.get(cwd) ?? 0) + 1)),
      () =>
        Effect.sync(() => {
          const next = (branchChangesDemand.get(cwd) ?? 1) - 1;
          if (next > 0) branchChangesDemand.set(cwd, next);
          else branchChangesDemand.delete(cwd);
        }),
    );
  const readLocalStatus = Effect.fn("VcsStatusBroadcaster.readLocalStatus")(function* (
    cwd: string,
  ) {
    const includeBranchChanges = wantsBranchChanges(cwd);
    const local = yield* workflow.localStatus({ cwd }, { includeBranchChanges });
    if (!includeBranchChanges && wantsBranchChanges(cwd)) {
      const detailed = yield* workflow.localStatus({ cwd }, { includeBranchChanges: true });
      branchChangesRead.set(cwd, true);
      return detailed;
    }
    branchChangesRead.set(cwd, includeBranchChanges);
    return local;
  });
  const headWatchers = yield* SynchronizedRef.make(
    new Map<
      string,
      {
        readonly fiber: Fiber.Fiber<void>;
        readonly ready: Deferred.Deferred<void>;
        readonly subscribers: number;
      }
    >(),
  );
  const branchEpochs = new Map<string, number>();

  const publishBranch = Effect.fn("VcsStatusBroadcaster.publishBranch")(function* (
    cwd: string,
    refName: string | null,
    isRepo: boolean,
    observation = ++branchObservation,
  ) {
    const previous = branches.get(cwd);
    if (previous && previous.observation > observation) return previous;
    const changed =
      previous === undefined || previous.refName !== refName || previous.isRepo !== isRepo;
    if (changed && previous !== undefined) branchEpochs.set(cwd, (branchEpochs.get(cwd) ?? 0) + 1);
    const next = {
      refName,
      isRepo,
      observation,
      revision: (previous?.revision ?? 0) + (changed ? 1 : 0),
    };
    branches.set(cwd, next);
    if (changed) yield* PubSub.publish(branchChangesPubSub, { cwd, ...next });
    return next;
  });
  const readAndPublishBranch = Effect.fn("VcsStatusBroadcaster.readAndPublishBranch")(function* (
    cwd: string,
  ) {
    const observation = ++branchObservation;
    const refName = yield* workflow.currentBranch(cwd);
    const isRepo = refName !== null || (yield* workflow.repositoryRoot(cwd)) !== null;
    return yield* publishBranch(cwd, refName, isRepo, observation);
  });
  const headRefreshRetry = Schedule.exponential(Duration.seconds(1)).pipe(
    Schedule.modifyDelay(({ duration }) =>
      Effect.succeed(Duration.min(duration, Duration.seconds(30))),
    ),
  );
  const watchHead = Effect.fnUntraced(function* (cwd: string, ready: Deferred.Deferred<void>) {
    const headPath = yield* workflow.headPath(cwd);
    if (headPath === null) return;
    const directory = path.dirname(headPath);
    yield* fs.watch(directory, { onReady: () => Deferred.doneUnsafe(ready, Exit.void) }).pipe(
      Stream.takeUntilEffect((event) =>
        event._tag === "Remove"
          ? fs.exists(directory).pipe(Effect.map((exists) => !exists))
          : Effect.succeed(false),
      ),
      Stream.filter((event) => path.basename(event.path) === "HEAD"),
      Stream.tap(() =>
        Effect.sync(() => {
          branchConfirmedUnder.delete(cwd);
          headGenerations.set(cwd, (headGenerations.get(cwd) ?? 0) + 1);
        }),
      ),
      Stream.buffer({ capacity: 1, strategy: "sliding" }),
      Stream.mapEffect(() => readAndPublishBranch(cwd).pipe(Effect.retry(headRefreshRetry))),
      Stream.buffer({ capacity: 1, strategy: "sliding" }),
      Stream.runForEach(() =>
        detailedSubscribers.has(cwd)
          ? Effect.gen(function* () {
              const cached = yield* getCachedStatus(cwd);
              yield* refreshLocalStatusCore(cwd, true);
              if (cached?.remote) yield* refreshRemoteStatus(cwd, { refreshUpstream: false });
            }).pipe(Effect.retry(headRefreshRetry))
          : Effect.void,
      ),
    );
  });
  const retainHeadWatcher = Effect.fn("VcsStatusBroadcaster.retainHeadWatcher")(function* (
    cwd: string,
  ) {
    const ready = yield* SynchronizedRef.modifyEffect(headWatchers, (watchers) => {
      const previous = watchers.get(cwd);
      if (previous && previous.fiber.pollUnsafe() === undefined) {
        return Effect.succeed([
          previous.ready,
          new Map(watchers).set(cwd, { ...previous, subscribers: previous.subscribers + 1 }),
        ] as const);
      }
      return Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        const fiber = yield* watchHead(cwd, ready).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("VCS HEAD watch failed", {
              cwdLength: cwd.length,
              ...remoteRefreshFailureDiagnostics(cause),
            }),
          ),
          Effect.ensuring(Deferred.succeed(ready, undefined)),
          Effect.forkIn(broadcasterScope),
        );
        return [
          ready,
          new Map(watchers).set(cwd, {
            ready,
            fiber,
            subscribers: (previous?.subscribers ?? 0) + 1,
          }),
        ] as const;
      });
    });
    yield* Deferred.await(ready);
  });
  const releaseHeadWatcher = Effect.fn("VcsStatusBroadcaster.releaseHeadWatcher")(function* (
    cwd: string,
  ) {
    const fiber = yield* SynchronizedRef.modify(headWatchers, (watchers) => {
      const current = watchers.get(cwd);
      if (!current) return [null, watchers] as const;
      const next = new Map(watchers);
      if (current.subscribers > 1) {
        next.set(cwd, { ...current, subscribers: current.subscribers - 1 });
        return [null, next] as const;
      }
      next.delete(cwd);
      branchConfirmedUnder.delete(cwd);
      headGenerations.delete(cwd);
      return [current.fiber, next] as const;
    });
    if (fiber) yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
  });
  const refreshBranchStatusCore = Effect.fn("VcsStatusBroadcaster.refreshBranchStatusCore")(
    (cwd: string) =>
      localRefreshLocks.withLock(
        cwd,
        Effect.gen(function* () {
          if (detailedSubscribers.has(cwd)) {
            const branch = yield* readAndPublishBranch(cwd);
            const cached = yield* getCachedStatus(cwd);
            if (
              cached?.local &&
              cached.local.value.refName === branch.refName &&
              cached.local.value.isRepo === branch.isRepo
            )
              return branch;
            yield* workflow.invalidateLocalStatus(cwd);
            yield* loadLocalStatus(cwd, { publish: true });
            return branches.get(cwd) ?? branch;
          }
          const observation = ++branchObservation;
          const refName = yield* workflow.currentBranch(cwd);
          const isRepo = refName !== null || (yield* workflow.repositoryRoot(cwd)) !== null;
          localRefreshResults.delete(cwd);
          yield* workflow.invalidateLocalStatus(cwd);
          yield* Ref.update(cacheRef, (cache) => {
            const previous = cache.get(cwd);
            return previous
              ? new Map(cache).set(cwd, {
                  ...previous,
                  revision: previous.revision + 1,
                  local: null,
                })
              : cache;
          });
          if (detailedSubscribers.has(cwd)) {
            const local = yield* loadLocalStatus(cwd, { publish: true });
            return (
              branches.get(cwd) ?? { refName: local.refName, isRepo: local.isRepo, revision: 0 }
            );
          }
          return yield* publishBranch(cwd, refName, isRepo, observation);
        }),
      ),
  );
  const refreshBranchStatus: VcsStatusBroadcaster["Service"]["refreshBranchStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshBranchStatus",
  )(function* (input) {
    const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
    if (!detailedSubscribers.has(cwd)) {
      const branch = yield* refreshBranchStatusCore(cwd);
      return { refName: branch.refName, isRepo: branch.isRepo };
    }
    const branch = yield* readAndPublishBranch(cwd);
    yield* refreshBranchStatusCore(cwd).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(broadcasterScope),
    );
    return { refName: branch.refName, isRepo: branch.isRepo };
  });
  const streamBranchStatus: VcsStatusBroadcaster["Service"]["streamBranchStatus"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
        const subscription = yield* PubSub.subscribe(branchChangesPubSub);
        yield* Effect.acquireRelease(retainHeadWatcher(cwd), () => releaseHeadWatcher(cwd));
        const branch = yield* refreshBranchStatusCore(cwd);
        return Stream.concat(
          Stream.make({ refName: branch.refName, isRepo: branch.isRepo }),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((event) => event.cwd === cwd && event.revision > branch.revision),
            Stream.map(({ refName, isRepo }) => ({ refName, isRepo })),
          ),
        ).pipe(
          Stream.changesWith(
            (left, right) => left.refName === right.refName && left.isRepo === right.isRepo,
          ),
        );
      }),
    );
  const refreshAfterCheckout: VcsStatusBroadcaster["Service"]["refreshAfterCheckout"] = Effect.fn(
    "VcsStatusBroadcaster.refreshAfterCheckout",
  )(function* (cwd) {
    const localDone = yield* Deferred.make<void>();
    yield* refreshLocalStatus(cwd).pipe(
      Effect.ensuring(Deferred.succeed(localDone, undefined)),
      Effect.andThen(refreshRemoteStatus(cwd, { refreshUpstream: false })),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(broadcasterScope),
    );
    yield* Deferred.await(localDone);
  });

  const cacheRef = yield* Ref.make(new Map<string, CachedVcsStatus>());
  const pollersRef = yield* SynchronizedRef.make(new Map<string, ActiveRemotePoller>());

  const cacheCommitLock = yield* Semaphore.make(1);
  const remoteLocks = yield* KeyedLock.make<string>();
  const upstreamReads = new Map<string, import("./GitVcsDriver.ts").GitRemoteStatusDetails>();
  const activeRemoteReads = new Map<string, number>();
  const cacheCapacity = 256;
  const trimCache = (cache: Map<string, CachedVcsStatus>, retained?: string) => {
    for (const key of cache.keys()) {
      if (cache.size <= cacheCapacity) break;
      if (key !== retained && !detailedSubscribers.has(key) && !activeRemoteReads.has(key)) {
        cache.delete(key);
        localRefreshResults.delete(key);
        upstreamReads.delete(key);
      }
    }
    return cache;
  };
  const emptyCachedStatus = (): CachedVcsStatus => ({ revision: 0, local: null, remote: null });

  const getCachedStatus = Effect.fn("VcsStatusBroadcaster.getCachedStatus")(function* (
    cwd: string,
  ) {
    return yield* Ref.modify(cacheRef, (cache) => {
      const cached = cache.get(cwd);
      if (!cached) return [null, cache] as const;
      const next = new Map(cache);
      next.delete(cwd);
      next.set(cwd, cached);
      return [cached, trimCache(next, cwd)] as const;
    });
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

  const withRemoteOperationLock = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => activeRemoteReads.set(cwd, (activeRemoteReads.get(cwd) ?? 0) + 1)),
      () => remoteLocks.withLock(cwd, effect),
      () =>
        Effect.sync(() => {
          const count = activeRemoteReads.get(cwd)! - 1;
          if (count) activeRemoteReads.set(cwd, count);
          else activeRemoteReads.delete(cwd);
        }).pipe(
          Effect.andThen(
            Ref.update(cacheRef, (cache) =>
              cache.size > cacheCapacity ? trimCache(new Map(cache)) : cache,
            ),
          ),
        ),
    );
  const observeRemoteStatusWithinLock = Effect.fn(
    "VcsStatusBroadcaster.observeRemoteStatusWithinLock",
  )(function* (
    cwd: string,
    options?: { readonly refreshUpstream?: boolean; readonly refreshMissingPullRequest?: boolean },
    knownLocal?: VcsStatusLocalResult,
  ) {
    let expectedRevision = (yield* getCachedStatus(cwd))?.revision ?? 0;
    const branchEpoch = branchEpochs.get(cwd) ?? 0;
    const localBefore = knownLocal ?? (yield* readLocalStatus(cwd));
    const effectiveOptions = options ?? {
      refreshUpstream: !Duration.isZero(yield* automaticFetchInterval),
    };
    const details = upstreamReads.get(cwd);
    upstreamReads.delete(cwd);
    const remoteOptions =
      options?.refreshMissingPullRequest && details && details.branch === localBefore.refName
        ? { ...effectiveOptions, statusDetails: details }
        : effectiveOptions;
    const remoteExit = yield* workflow.remoteStatus({ cwd }, remoteOptions).pipe(Effect.exit);
    yield* workflow.invalidateLocalStatus(cwd);
    const localAfter = yield* readLocalStatus(cwd);
    if (!sameLocalIdentity(localBefore, localAfter)) {
      return { _tag: "unstable" as const, expectedRevision, local: localAfter } as const;
    }
    if (Exit.isFailure(remoteExit)) {
      return yield* Effect.failCause(remoteExit.cause);
    }
    const latest = yield* getCachedStatus(cwd);
    const sameBranchEpoch = (branchEpochs.get(cwd) ?? 0) === branchEpoch;
    const canUseLatestLocal =
      latest?.local &&
      latest.revision !== expectedRevision &&
      sameBranchEpoch &&
      sameLocalIdentity(localBefore, latest.local.value);
    let remote = remoteExit.value;
    if (canUseLatestLocal && latest.revision !== expectedRevision) {
      if (remote?.hasUpstream) {
        const divergence = yield* workflow.upstreamDivergence(cwd);
        if (divergence?.refName === localBefore.refName)
          remote = {
            ...remote,
            aheadCount: divergence.aheadCount,
            behindCount: divergence.behindCount,
          };
      }
      expectedRevision = latest.revision;
    }
    return {
      _tag: "stable" as const,
      expectedRevision,
      local: canUseLatestLocal ? latest.local.value : localAfter,
      remote,
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
        branchObservation?: number;
        remoteAlreadyInvalidated?: boolean;
      },
    ) {
      const nextLocal = {
        fingerprint: fingerprintStatusPart(local),
        value: local,
      } satisfies CachedValue<VcsStatusLocalResult>;
      return yield* cacheCommitLock.withPermit(
        Effect.gen(function* () {
          const previous = yield* getCachedStatus(cwd);
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
              if (previous.local?.fingerprint === nextLocal.fingerprint) {
                return [{ committed: true, shouldPublish: false }, cache] as const;
              }
              const nextCache = new Map(cache);
              nextCache.delete(cwd);
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
                trimCache(nextCache, cwd),
              ] as const;
            },
          );

          if (
            result.committed &&
            !options?.remoteAlreadyInvalidated &&
            previous?.remote &&
            !sameLocalIdentity(previous.local?.value ?? local, local)
          ) {
            yield* workflow.invalidateRemoteStatus(cwd);
          }
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

          if (result.committed)
            yield* publishBranch(cwd, local.refName, local.isRepo, options?.branchObservation);
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
              nextCache.delete(cwd);
              nextCache.set(cwd, {
                revision: previous.revision + 1,
                local: nextLocal,
                remote: nextRemote,
              });
              return [
                { committed: true, localChanged, remoteChanged },
                trimCache(nextCache, cwd),
              ] as const;
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

          if (changes.committed)
            yield* publishBranch(cwd, observedLocal.refName, observedLocal.isRepo);
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
            nextCache.delete(cwd);
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
              trimCache(nextCache, cwd),
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

        if (result.committed) yield* publishBranch(cwd, local.refName, local.isRepo);
        return result.committed ? mergeGitStatusParts(local, remote) : null;
      }),
    );
  });

  const loadLocalStatus = Effect.fn("VcsStatusBroadcaster.loadLocalStatus")(function* (
    cwd: string,
    options?: { publish?: boolean },
  ) {
    const observation = ++branchObservation;
    const local = yield* readLocalStatus(cwd);
    yield* updateCachedLocalStatus(cwd, local, { ...options, branchObservation: observation });
    return local;
  });

  const branchConfirmedUnder = new Map<string, Fiber.Fiber<void, never>>();
  // Bumped on every HEAD event, so a read that a checkout overtook cannot confirm its branch.
  const headGenerations = new Map<string, number>();
  const readyHeadWatch = (cwd: string) =>
    SynchronizedRef.get(headWatchers).pipe(
      Effect.map((watchers) => {
        const watcher = watchers.get(cwd);
        return watcher &&
          watcher.fiber.pollUnsafe() === undefined &&
          Deferred.isDoneUnsafe(watcher.ready)
          ? watcher.fiber
          : undefined;
      }),
    );

  const getOrLoadLocalStatus = Effect.fn("VcsStatusBroadcaster.getOrLoadLocalStatus")(function* (
    cwd: string,
  ) {
    const watch = yield* readyHeadWatch(cwd);
    const generation = headGenerations.get(cwd);
    const confirm = <A>(value: A) => {
      if (watch !== undefined && headGenerations.get(cwd) === generation) {
        branchConfirmedUnder.set(cwd, watch);
      }
      return value;
    };
    const cached = yield* getCachedStatus(cwd);
    if (cached?.local) {
      if (branchChangesRead.get(cwd) || !wantsBranchChanges(cwd)) {
        if (watch !== undefined && branchConfirmedUnder.get(cwd) === watch) {
          return cached.local.value;
        }
        const branch = yield* workflow.currentBranch(cwd);
        if (branch === cached.local.value.refName) return confirm(cached.local.value);
      }
      yield* workflow.invalidateLocalStatus(cwd);
      return confirm(yield* loadLocalStatus(cwd, { publish: true }));
    }
    return confirm(yield* loadLocalStatus(cwd));
  });

  const withFileSystem = Effect.provideService(FileSystem.FileSystem, fs);

  const getStatus: VcsStatusBroadcaster["Service"]["getStatus"] = Effect.fn(
    "VcsStatusBroadcaster.getStatus",
  )(function* (input) {
    const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
    yield* acquireBranchChangesDemand(cwd);
    const before = yield* getCachedStatus(cwd);
    if (before?.local && (yield* workflow.currentBranch(cwd)) !== before.local.value.refName) {
      yield* refreshLocalStatusCore(cwd);
    }
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
        yield* updateCachedStatus(cwd, observed.local, observed.remote, {
          expectedRevision: observed.expectedRevision,
        });
        const current = yield* getCachedStatus(cwd);
        const currentLocal = current?.local?.value ?? observed.local;
        return mergeGitStatusParts(
          currentLocal,
          getCompatibleCachedRemote(currentLocal, current)?.value ?? null,
        );
      }),
    );
  }, Effect.scoped);

  // A refresh that started after a request saw every change that request could mean, so queued
  // callers share it instead of each running git status again.
  const localRefreshLocks = yield* KeyedLock.make<string>();
  const localRefreshRequests = new Map<string, number>();
  const localRefreshResults = new Map<
    string,
    { readonly startedAt: number; readonly local: VcsStatusLocalResult }
  >();
  const refreshLocalStatusCore = Effect.fn("VcsStatusBroadcaster.refreshLocalStatusCore")(
    function* (cwd: string, preserveRemotePoller = false) {
      const requestedAt = (localRefreshRequests.get(cwd) ?? 0) + 1;
      localRefreshRequests.set(cwd, requestedAt);
      return yield* localRefreshLocks.withLock(
        cwd,
        Effect.gen(function* () {
          const shared = localRefreshResults.get(cwd);
          if (
            shared !== undefined &&
            shared.startedAt >= requestedAt &&
            (!wantsBranchChanges(cwd) || branchChangesRead.get(cwd))
          )
            return shared.local;
          const startedAt = localRefreshRequests.get(cwd) ?? requestedAt;
          yield* workflow.invalidateLocalStatus(cwd);
          const observation = ++branchObservation;
          const local = yield* readLocalStatus(cwd);
          localRefreshResults.set(cwd, { startedAt, local });
          yield* updateCachedLocalStatus(cwd, local, {
            publish: true,
            branchObservation: observation,
            preserveRemotePoller,
          });
          return local;
        }),
      );
    },
  );

  const maybeAutoPull = Effect.fn("VcsStatusBroadcaster.maybeAutoPull")(function* (
    cwd: string,
    remoteRead: CachedRemoteStatus | null,
    policyCwds: ReadonlyArray<string>,
  ) {
    const remote = remoteRead?.value ?? null;
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
      const local = yield* readLocalStatus(cwd);
      if (
        !local.isRepo ||
        !local.isDefaultRef ||
        local.hasWorkingTreeChanges ||
        local.refName !== remoteRead?.branch
      )
        return null;

      expectedRevision = (yield* getCachedStatus(cwd))?.revision ?? 0;
      pullAttempted = true;
      yield* workflow.pullCurrentBranch(cwd);
      yield* workflow.invalidateStatus(cwd);
      const [refreshedLocal, refreshedRemote] = yield* Effect.all(
        [readLocalStatus(cwd), workflow.remoteStatus({ cwd }, { refreshUpstream: false })],
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
          const local = yield* readLocalStatus(cwd);
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
            : yield* maybeAutoPull(
                cwd,
                {
                  branch: observed.local.refName,
                  value: observed.remote,
                  fingerprint: fingerprintStatusPart(observed.remote),
                },
                options?.policyCwds ?? [cwd],
              );
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

  const withRefsDigest = Effect.fnUntraced(function* (
    cwd: string,
    status: VcsStatusResult,
  ): Effect.fn.Return<VcsRefreshStatusResult> {
    // The digest is a cache hint. Preserve the refreshed status if its lookup fails.
    const refs = yield* Effect.suspend(() => workflow.readRefSnapshot(cwd)).pipe(
      Effect.catchDefect(() => Effect.succeed(null)),
    );
    return refs === null
      ? status
      : {
          ...status,
          refsDigest: NodeCrypto.createHash("sha256").update(refs).digest("hex").slice(0, 32),
        };
  });
  const refreshStatusCore = Effect.fn("VcsStatusBroadcaster.refreshStatusCore")(function* (
    cwd: string,
    rawCwd: string,
    shouldRun: Effect.Effect<boolean>,
  ) {
    if (!(yield* shouldRun)) return undefined;
    // Publish local changes even while another remote lookup owns the lock.
    yield* workflow.invalidateStatus(cwd);
    const local = yield* readLocalStatus(cwd);
    yield* updateCachedLocalStatus(cwd, local, { publish: true, remoteAlreadyInvalidated: true });
    return yield* withRemoteOperationLock(
      cwd,
      Effect.gen(function* () {
        if (!(yield* shouldRun)) return undefined;
        const observed = yield* observeRemoteStatusWithinLock(cwd, undefined, local);
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
          : yield* maybeAutoPull(
              cwd,
              {
                branch: observed.local.refName,
                value: observed.remote,
                fingerprint: fingerprintStatusPart(observed.remote),
              },
              [rawCwd],
            );
        if (pulled !== null) {
          const current = yield* getCachedStatus(cwd);
          const currentLocal = current?.local?.value ?? pulled.local;
          return mergeGitStatusParts(
            currentLocal,
            getCompatibleCachedRemote(currentLocal, current)?.value ?? null,
          );
        }
        yield* updateCachedStatus(cwd, observed.local, observed.remote, {
          expectedRevision: observed.expectedRevision,
          publish: true,
        });
        const current = yield* getCachedStatus(cwd);
        const currentLocal = current?.local?.value ?? observed.local;
        return yield* withRefsDigest(
          cwd,
          mergeGitStatusParts(
            currentLocal,
            getCompatibleCachedRemote(currentLocal, current)?.value ?? null,
          ),
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
      startedAt: number;
      readonly result: Deferred.Deferred<A, GitManagerServiceError>;
      foregroundWaiters: number;
      backgroundRequestedAt: number | null;
    }
    interface RefreshLane {
      current: RefreshBatch;
      pending: RefreshBatch | null;
    }
    const refreshLanes = new Map<string, RefreshLane>();
    const completed = new Map<string, RefreshBatch>();
    let requestSequence = 0;
    const reserve = () => ++requestSequence;

    const drainRefreshLane = (cwd: string, lane: RefreshLane) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          while (true) {
            const batch = lane.current;
            batch.startedAt = requestSequence;
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
              completed.set(cwd, batch);
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
      requestId = reserve(),
    ) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const existing = refreshLanes.get(cwd);
          const shared =
            existing?.current && existing.current.startedAt >= requestId
              ? existing.current
              : completed.get(cwd)?.startedAt !== undefined &&
                  completed.get(cwd)!.startedAt >= requestId &&
                  (!wantsBranchChanges(cwd) || branchChangesRead.get(cwd))
                ? completed.get(cwd)!
                : undefined;
          const batch = shared ??
            existing?.pending ?? {
              rawCwd,
              startedAt: 0,
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
          if (shared) return batch;
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

    const refreshCanonical = Effect.fn("refreshCanonical")(function* (
      cwd: string,
      rawCwd: string,
      requestId = reserve(),
    ) {
      return yield* Effect.acquireUseRelease(
        enqueueRefresh(cwd, rawCwd, false, undefined, requestId),
        (batch) => Deferred.await(batch.result),
        (batch) =>
          Effect.sync(() => {
            batch.foregroundWaiters -= 1;
          }),
      );
    });

    const refresh = Effect.fn("refresh")(function* (rawCwd: string) {
      const requestId = reserve();
      const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
      return yield* refreshCanonical(cwd, rawCwd, requestId);
    });

    const refreshInBackground = Effect.fn("refreshInBackground")(function* (rawCwd: string) {
      const requestId = reserve();
      const requestedAt = yield* Clock.currentTimeMillis;
      // Path resolution can itself wait on a remote filesystem. Git actions must not await it.
      yield* Effect.gen(function* () {
        const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
        yield* enqueueRefresh(cwd, rawCwd, true, requestedAt, requestId);
      }).pipe(Effect.interruptible, Effect.forkIn(broadcasterScope, { startImmediately: true }));
    });

    return { refresh, refreshInBackground, refreshCanonical, reserve };
  };

  const fullRefresh = makeRefreshLane(refreshStatusCore);
  const refreshStatus: VcsStatusBroadcaster["Service"]["refreshStatus"] = (rawCwd, options) =>
    Effect.scoped(
      Effect.gen(function* () {
        const requestId = options?.localOnly ? localRefresh.reserve() : fullRefresh.reserve();
        const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
        yield* acquireBranchChangesDemand(cwd);
        return yield* options?.localOnly
          ? Effect.gen(function* () {
              const local = yield* localRefresh.refreshCanonical(cwd, rawCwd, requestId);
              const cache = yield* getCachedStatus(cwd);
              return yield* withRefsDigest(
                cwd,
                mergeGitStatusParts(local, getCompatibleCachedRemote(local, cache)?.value ?? null),
              );
            })
          : fullRefresh.refreshCanonical(cwd, rawCwd, requestId);
      }),
    );
  const refreshStatusInBackground = Effect.fn("VcsStatusBroadcaster.refreshStatusInBackground")(
    fullRefresh.refreshInBackground,
  );
  const localRefresh = makeRefreshLane<VcsStatusLocalResult>((cwd, _rawCwd, shouldRun) =>
    Effect.gen(function* () {
      if (!(yield* shouldRun)) return undefined;
      return yield* refreshLocalStatusCore(cwd);
    }),
  );
  const refreshLocalDivergence = Effect.fn("VcsStatusBroadcaster.refreshLocalDivergence")(
    function* (cwd: string) {
      const cached = yield* getCachedStatus(cwd);
      if (
        !cached?.local ||
        !getCompatibleCachedRemote(cached.local.value, cached)?.value?.hasUpstream
      )
        return;
      upstreamReads.delete(cwd);
      const divergence = yield* workflow.upstreamDivergence(cwd);
      const latest = yield* getCachedStatus(cwd);
      if (!divergence || !latest?.local || latest.local.value.refName !== divergence.refName)
        return;
      const remote = getCompatibleCachedRemote(latest.local.value, latest)?.value;
      if (!remote) return;
      if (divergence.details) upstreamReads.set(cwd, divergence.details);
      yield* updateCachedRemoteStatus(
        cwd,
        { ...remote, aheadCount: divergence.aheadCount, behindCount: divergence.behindCount },
        latest.local.value,
        { expectedRevision: latest.revision, publish: true },
      );
    },
  );
  const refreshLocalStatus = Effect.fn("VcsStatusBroadcaster.refreshLocalStatus")(function* (
    rawCwd: string,
  ) {
    const local = yield* localRefresh.refresh(rawCwd);
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    yield* refreshLocalDivergence(cwd);
    return local;
  });

  const pullRequestRefresh = makeRefreshLane<VcsStatusRemoteResult | null>(
    (cwd, rawCwd, shouldRun) =>
      withRemoteOperationLock(
        cwd,
        Effect.gen(function* () {
          if (!(yield* shouldRun)) return undefined;
          const cached = yield* getCachedStatus(cwd);
          if (cached == null) return null;
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
        if (input.includeRemote !== false) yield* acquireBranchChangesDemand(cwd);
        const subscription = yield* PubSub.subscribe(changesPubSub);
        yield* Effect.acquireRelease(
          Effect.sync(() => detailedSubscribers.set(cwd, (detailedSubscribers.get(cwd) ?? 0) + 1)),
          () =>
            Effect.sync(() => {
              const count = (detailedSubscribers.get(cwd) ?? 1) - 1;
              if (count === 0) detailedSubscribers.delete(cwd);
              else detailedSubscribers.set(cwd, count);
            }).pipe(
              Effect.andThen(
                Ref.update(cacheRef, (cache) =>
                  cache.size > cacheCapacity ? trimCache(new Map(cache)) : cache,
                ),
              ),
            ),
        );
        yield* Effect.acquireRelease(retainHeadWatcher(cwd), () => releaseHeadWatcher(cwd));
        const initialLocal = yield* localRefreshLocks.withLock(cwd, getOrLoadLocalStatus(cwd));
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
    streamBranchChanges: Stream.fromPubSub(branchChangesPubSub).pipe(
      Stream.map(({ cwd, refName }) => ({ cwd, refName })),
    ),
    refreshBranchStatus,
    streamBranchStatus,
    refreshAfterCheckout,
    getStatus,
    refreshLocalStatus,
    refreshStatus,
    refreshStatusInBackground,
    refreshPullRequestStatus,
    streamStatus,
  });
});

export const layer = Layer.effect(VcsStatusBroadcaster, make);
