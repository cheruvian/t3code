// @effect-diagnostics nodeBuiltinImport:off
/**
 * Best-effort provider event logging with one shared writer per thread.
 *
 * Native and canonical views share batching, rotation, and retention state so
 * they cannot race while appending to the same thread-scoped file.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ThreadId } from "@t3tools/contracts";
import { RotatingFileSink } from "@t3tools/shared/logging";
import { causeErrorTag, errorTag } from "@t3tools/shared/observability";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { toSafeThreadAttachmentSegment } from "../../attachmentStore.ts";
import type { ResourceAttribution } from "../../resourceTelemetry/ResourceAttribution.ts";

const MEBIBYTE = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_BYTES = 10 * MEBIBYTE;
const DEFAULT_MAX_FILES = 10;
const DEFAULT_BATCH_WINDOW_MS = 1_000;
const DEFAULT_MAX_TOTAL_BYTES = 512 * MEBIBYTE;
const DEFAULT_MAX_AGE_MS = 14 * DAY_MS;
const DEFAULT_RETENTION_CHECK_INTERVAL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_BUFFERED_BYTES = MEBIBYTE;
const DEFAULT_MAX_BUFFERED_RECORDS = 512;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_LOSS_DETAILS = 32;
const MAX_LOSS_COUNT = Number.MAX_SAFE_INTEGER;
const MIN_BUFFERED_BYTES = 512;
const GLOBAL_THREAD_SEGMENT = "_global";
const LOG_SCOPE = "provider-observability";
const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const transientCanonicalEventTypes = new Set([
  "content.delta",
  "hook.progress",
  "item.updated",
  "task.progress",
  "thread.realtime.audio.delta",
  "tool.progress",
  "turn.proposed.delta",
]);

export type EventNdjsonStream = "native" | "canonical" | "orchestration";

export interface EventNdjsonSink {
  readonly write: (lines: string) => Effect.Effect<void>;
}

export interface EventNdjsonSinkFactory {
  (input: {
    readonly filePath: string;
    readonly maxBytes: number;
    readonly maxFiles: number;
  }): EventNdjsonSink;
}

export interface EventNdjsonLossCounts {
  readonly lowValue: number;
  readonly protected: number;
}

export interface EventNdjsonAdmissionCounts {
  readonly pendingRecords: number;
  readonly pendingBytes: number;
  readonly lossCounts: EventNdjsonLossCounts;
}

export type EventNdjsonAdmission =
  | ({ readonly _tag: "Accepted" } & EventNdjsonAdmissionCounts)
  | ({
      readonly _tag: "Rejected";
      readonly reason:
        | "closed"
        | "filtered"
        | "serialization-failed"
        | "low-value-buffer-full"
        | "protected-buffer-full";
    } & EventNdjsonAdmissionCounts);

export interface EventNdjsonLogger {
  readonly filePath: string;
  readonly write: (
    event: unknown,
    threadId: ThreadId | null,
  ) => Effect.Effect<EventNdjsonAdmission>;
  readonly drain?: () => Effect.Effect<void>;
  readonly close: () => Effect.Effect<void>;
}

export interface EventNdjsonLogStore {
  readonly filePath: string;
  readonly logger: (stream: EventNdjsonStream) => EventNdjsonLogger;
  readonly drain: () => Effect.Effect<void>;
  readonly close: () => Effect.Effect<void>;
}

export interface EventNdjsonLogStoreOptions {
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly batchWindowMs?: number;
  readonly maxTotalBytes?: number;
  readonly maxAgeMs?: number;
  readonly retentionCheckIntervalMs?: number;
  readonly maxBufferedBytes?: number;
  readonly maxBufferedRecords?: number;
  readonly closeTimeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly sinkFactory?: EventNdjsonSinkFactory;
  readonly attribution?: ResourceAttribution["Service"];
}

export interface EventNdjsonLoggerOptions extends EventNdjsonLogStoreOptions {
  readonly stream: EventNdjsonStream;
}

export class EventNdjsonLogConfigurationError extends Schema.TaggedErrorClass<EventNdjsonLogConfigurationError>()(
  "EventNdjsonLogConfigurationError",
  {
    filePath: Schema.String,
    option: Schema.String,
    value: Schema.Number,
    minimum: Schema.Number,
  },
) {
  override get message(): string {
    return `Provider event log option '${this.option}' must be an integer >= ${this.minimum}; received ${this.value} for '${this.filePath}'`;
  }
}

export class EventNdjsonLogDirectoryError extends Schema.TaggedErrorClass<EventNdjsonLogDirectoryError>()(
  "EventNdjsonLogDirectoryError",
  {
    directory: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to create provider event log directory '${this.directory}'`;
  }
}

export type EventNdjsonLogStoreError =
  | EventNdjsonLogConfigurationError
  | EventNdjsonLogDirectoryError;

export class EventNdjsonLogCloseTimeout extends Schema.TaggedErrorClass<EventNdjsonLogCloseTimeout>()(
  "EventNdjsonLogCloseTimeout",
  {
    filePath: Schema.String,
    timeoutMs: Schema.Int,
    pendingRecords: Schema.Int,
    pendingBytes: Schema.Int,
    lossCounts: Schema.Struct({
      lowValue: Schema.Int,
      protected: Schema.Int,
    }),
  },
) {
  override get message(): string {
    return `Provider event log close exceeded ${this.timeoutMs}ms with ${this.pendingRecords} pending records`;
  }
}

interface ResolvedOptions {
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
  readonly maxTotalBytes: number;
  readonly maxAgeMs: number;
  readonly retentionCheckIntervalMs: number;
  readonly maxBufferedBytes: number;
  readonly maxBufferedRecords: number;
  readonly closeTimeoutMs: number;
  readonly retryDelayMs: number;
  readonly sinkFactory: EventNdjsonSinkFactory;
  readonly attribution: ResourceAttribution["Service"] | undefined;
}

export interface PendingRecord {
  readonly stream: EventNdjsonStream;
  readonly threadSegment: string;
  readonly line: string;
  readonly bytes: number;
}

interface QueuedRecord extends PendingRecord {
  readonly id: number;
  readonly priority: "low-value" | "protected";
  readonly lossSummary: boolean;
}

interface PendingSubmission {
  readonly id: number;
  readonly stream: EventNdjsonStream;
  readonly threadSegment: string;
  readonly event: unknown;
  readonly priority: "low-value" | "protected";
  readonly category: string;
}

interface LossDetail {
  readonly threadSegment: string;
  readonly category: string;
  readonly lowValue: number;
  readonly protected: number;
}

interface StoreState {
  readonly pending: ReadonlyArray<QueuedRecord>;
  readonly submissions: ReadonlyArray<PendingSubmission>;
  readonly pendingBytes: number;
  readonly sinks: ReadonlyMap<string, EventNdjsonSink>;
  readonly inFlightRecords: number;
  readonly inFlightSubmission: boolean;
  readonly closed: boolean;
  readonly nextId: number;
  readonly lastRetentionAt: number;
  readonly lossCounts: EventNdjsonLossCounts;
  readonly unsummarizedLossCounts: EventNdjsonLossCounts;
  readonly lossDetails: ReadonlyMap<string, LossDetail>;
  readonly summaryPending: boolean;
  readonly drainWaiters: ReadonlyArray<Deferred.Deferred<void>>;
}

interface AttributionSummary {
  readonly stream: EventNdjsonStream;
  readonly count: number;
  readonly logicalWriteBytes: number;
}

interface FileOperationFailure {
  readonly filePath: string;
  readonly cause: unknown;
}

interface RetentionResult {
  readonly failures: ReadonlyArray<FileOperationFailure>;
}

interface DrainResult {
  readonly attributions: ReadonlyArray<AttributionSummary>;
  readonly failures: ReadonlyArray<FileOperationFailure>;
}

function logWarning(message: string, context: Record<string, unknown>): Effect.Effect<void> {
  return Effect.logWarning(message, context).pipe(Effect.annotateLogs({ scope: LOG_SCOPE }));
}

const defaultSinkFactory: EventNdjsonSinkFactory = (input) => {
  const sink = new RotatingFileSink({
    ...input,
    throwOnError: true,
  });
  return {
    write: (lines) => Effect.sync(() => sink.write(lines)),
  };
};

function resolveThreadSegment(raw: string | null | undefined): string {
  const normalized = typeof raw === "string" ? toSafeThreadAttachmentSegment(raw) : null;
  return normalized ?? GLOBAL_THREAD_SEGMENT;
}

function resolveStreamLabel(stream: EventNdjsonStream): string {
  return stream === "native" ? "NTIVE" : stream === "orchestration" ? "ORCH" : "CANON";
}

function providerLogPrefix(filePath: string): string {
  const basename = NodePath.basename(filePath);
  const extension = NodePath.extname(basename);
  return `${extension.length > 0 ? basename.slice(0, -extension.length) : basename}.`;
}

function providerLogPath(directory: string, prefix: string, threadSegment: string): string {
  return NodePath.join(directory, `${prefix}${threadSegment}.log`);
}

function shouldPersist(stream: EventNdjsonStream, event: unknown): boolean {
  if (stream !== "canonical" || typeof event !== "object" || event === null) {
    return true;
  }
  try {
    const type = Reflect.get(event, "type");
    return typeof type !== "string" || !transientCanonicalEventTypes.has(type);
  } catch {
    return true;
  }
}

function eventCategory(event: unknown): string {
  const readString = (value: unknown, key: string): string | undefined => {
    if (typeof value !== "object" || value === null) return undefined;
    try {
      const field = Reflect.get(value, key);
      return typeof field === "string" ? field : undefined;
    } catch {
      return undefined;
    }
  };
  const direct = readString(event, "type") ?? readString(event, "method");
  if (direct) return direct.slice(0, 96);

  if (typeof event === "object" && event !== null) {
    try {
      const nested = Reflect.get(event, "event");
      const nestedCategory = readString(nested, "type") ?? readString(nested, "method");
      if (nestedCategory) return nestedCategory.slice(0, 96);
    } catch {
      // Hostile accessors are handled as an unknown protected event.
    }
  }
  return "unknown";
}

function isLowValueEvent(stream: EventNdjsonStream, event: unknown): boolean {
  const category = eventCategory(event);
  if (stream === "canonical" && transientCanonicalEventTypes.has(category)) return true;
  return /(?:^|[./:_-])(?:delta|progress)(?:$|[./:_-])/iu.test(category);
}

function incrementBounded(value: number): number {
  return Math.min(MAX_LOSS_COUNT, value + 1);
}

export function writeBatchedMessages(
  sink: Pick<RotatingFileSink, "write">,
  records: ReadonlyArray<PendingRecord>,
  maxBytes: number,
  onWritten: (records: ReadonlyArray<PendingRecord>) => void,
): void {
  let pendingRecords: Array<PendingRecord> = [];
  let pendingBytes = 0;

  const flush = () => {
    if (pendingRecords.length === 0) return;
    const writtenRecords = pendingRecords;
    sink.write(writtenRecords.map((record) => record.line).join(""));
    onWritten(writtenRecords);
    pendingRecords = [];
    pendingBytes = 0;
  };

  for (const record of records) {
    if (pendingBytes > 0 && pendingBytes + record.bytes > maxBytes) {
      flush();
    }
    pendingRecords.push(record);
    pendingBytes += record.bytes;
    if (pendingBytes >= maxBytes) {
      flush();
    }
  }
  flush();
}

function isProviderLogFile(filePath: string, fileName: string, filePrefix: string): boolean {
  if (!/\.log(?:\.\d+)?$/u.test(fileName)) return false;
  if (fileName.startsWith(filePrefix)) return true;

  const descriptor = NodeFS.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(256);
    const bytesRead = NodeFS.readSync(descriptor, header, 0, header.byteLength, 0);
    return /^\[[^\]\r\n]+\] (?:NTIVE|CANON|ORCH): /u.test(header.toString("utf8", 0, bytesRead));
  } finally {
    NodeFS.closeSync(descriptor);
  }
}

function enforceRetention(input: {
  readonly directory: string;
  readonly maxTotalBytes: number;
  readonly maxAgeMs: number;
  readonly activeFilePaths: ReadonlySet<string>;
  readonly filePrefix: string;
  readonly now: number;
}): RetentionResult {
  const failures: Array<FileOperationFailure> = [];
  const files: Array<{ filePath: string; mtimeMs: number; size: number }> = [];

  let entries: ReadonlyArray<NodeFS.Dirent>;
  try {
    entries = NodeFS.readdirSync(input.directory, { withFileTypes: true });
  } catch (cause) {
    return { failures: [{ filePath: input.directory, cause }] };
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = NodePath.join(input.directory, entry.name);
    try {
      if (!isProviderLogFile(filePath, entry.name, input.filePrefix)) continue;
      const stat = NodeFS.statSync(filePath);
      files.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch (cause) {
      failures.push({ filePath, cause });
    }
  }

  let totalBytes = files.reduce((total, file) => total + file.size, 0);
  const remove = (file: (typeof files)[number]) => {
    if (input.activeFilePaths.has(file.filePath)) return false;
    try {
      NodeFS.rmSync(file.filePath, { force: true });
      totalBytes -= file.size;
      return true;
    } catch (cause) {
      failures.push({ filePath: file.filePath, cause });
      return false;
    }
  };

  const retained = files.filter((file) => {
    if (input.now - file.mtimeMs <= input.maxAgeMs) return true;
    return !remove(file);
  });

  for (const file of retained.toSorted(
    (left, right) => left.mtimeMs - right.mtimeMs || left.filePath.localeCompare(right.filePath),
  )) {
    if (totalBytes <= input.maxTotalBytes) break;
    remove(file);
  }

  return { failures };
}

function validateOption(input: {
  readonly filePath: string;
  readonly option: string;
  readonly value: number;
  readonly minimum: number;
}): EventNdjsonLogConfigurationError | undefined {
  if (Number.isInteger(input.value) && input.value >= input.minimum) return undefined;
  return new EventNdjsonLogConfigurationError(input);
}

function resolveOptions(
  filePath: string,
  options: EventNdjsonLogStoreOptions,
): Effect.Effect<ResolvedOptions, EventNdjsonLogConfigurationError> {
  const resolved = {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    batchWindowMs: options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    maxAgeMs: options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    retentionCheckIntervalMs:
      options.retentionCheckIntervalMs ?? DEFAULT_RETENTION_CHECK_INTERVAL_MS,
    maxBufferedBytes: options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
    maxBufferedRecords: options.maxBufferedRecords ?? DEFAULT_MAX_BUFFERED_RECORDS,
    closeTimeoutMs: options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
    retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    sinkFactory: options.sinkFactory ?? defaultSinkFactory,
    attribution: options.attribution,
  } satisfies ResolvedOptions;

  const validations = [
    ["maxBytes", resolved.maxBytes, 1],
    ["maxFiles", resolved.maxFiles, 1],
    ["batchWindowMs", resolved.batchWindowMs, 0],
    ["maxTotalBytes", resolved.maxTotalBytes, 1],
    ["maxAgeMs", resolved.maxAgeMs, 1],
    ["retentionCheckIntervalMs", resolved.retentionCheckIntervalMs, 1],
    ["maxBufferedBytes", resolved.maxBufferedBytes, MIN_BUFFERED_BYTES],
    ["maxBufferedRecords", resolved.maxBufferedRecords, 1],
    ["closeTimeoutMs", resolved.closeTimeoutMs, 1],
    ["retryDelayMs", resolved.retryDelayMs, 1],
  ] as const;

  for (const [option, value, minimum] of validations) {
    const error = validateOption({ filePath, option, value, minimum });
    if (error) return Effect.fail(error);
  }
  return Effect.succeed(resolved);
}

function pendingRecordCount(state: StoreState): number {
  return state.pending.length + state.submissions.length;
}

function admissionCounts(state: StoreState): EventNdjsonAdmissionCounts {
  return {
    pendingRecords: pendingRecordCount(state),
    pendingBytes: state.pendingBytes,
    lossCounts: state.lossCounts,
  };
}

function lossDetailKey(threadSegment: string, category: string): string {
  return `${threadSegment}\u0000${category}`;
}

function recordLoss(
  state: StoreState,
  priority: "low-value" | "protected",
  threadSegment: string,
  category: string,
): StoreState {
  const field = priority === "low-value" ? "lowValue" : "protected";
  const lossCounts = {
    ...state.lossCounts,
    [field]: incrementBounded(state.lossCounts[field]),
  };
  const unsummarizedLossCounts = {
    ...state.unsummarizedLossCounts,
    [field]: incrementBounded(state.unsummarizedLossCounts[field]),
  };
  const normalizedThreadSegment = threadSegment.slice(0, 96);
  const normalizedCategory = category.slice(0, 96);
  let key = lossDetailKey(normalizedThreadSegment, normalizedCategory);
  const details = new Map(state.lossDetails);
  if (!details.has(key) && details.size >= MAX_LOSS_DETAILS) {
    key = lossDetailKey("_other", "_other");
  }
  const current = details.get(key) ?? {
    threadSegment: key === lossDetailKey("_other", "_other") ? "_other" : normalizedThreadSegment,
    category: key === lossDetailKey("_other", "_other") ? "_other" : normalizedCategory,
    lowValue: 0,
    protected: 0,
  };
  details.set(key, {
    ...current,
    [field]: incrementBounded(current[field]),
  });
  return {
    ...state,
    lossCounts,
    unsummarizedLossCounts,
    lossDetails: details,
    summaryPending: true,
  };
}

function canFitRecord(state: StoreState, bytes: number, options: ResolvedOptions): boolean {
  return (
    pendingRecordCount(state) < options.maxBufferedRecords &&
    state.pendingBytes + bytes <= options.maxBufferedBytes
  );
}

function evictOldestLowValue(state: StoreState): StoreState | undefined {
  const pendingIndex = state.pending.findIndex(
    (record, index) => index >= state.inFlightRecords && record.priority === "low-value",
  );
  const submissionIndex = state.submissions.findIndex((submission, index) =>
    !state.inFlightSubmission || index > 0 ? submission.priority === "low-value" : false,
  );
  const pending = pendingIndex >= 0 ? state.pending[pendingIndex] : undefined;
  const submission = submissionIndex >= 0 ? state.submissions[submissionIndex] : undefined;
  if (!pending && !submission) return undefined;

  if (pending && (!submission || pending.id < submission.id)) {
    const next = recordLoss(state, "low-value", pending.threadSegment, "queued-delta");
    return {
      ...next,
      pending: next.pending.filter((_, index) => index !== pendingIndex),
      pendingBytes: next.pendingBytes - pending.bytes,
    };
  }

  if (!submission) return undefined;
  const next = recordLoss(state, "low-value", submission.threadSegment, submission.category);
  return {
    ...next,
    submissions: next.submissions.filter((_, index) => index !== submissionIndex),
  };
}

function makeLossSummaryRecord(
  state: StoreState,
  observedAt: string,
  maxBufferedBytes: number,
): QueuedRecord {
  const base = {
    type: "provider.event-log.loss-summary",
    lossCounts: state.lossCounts,
  };
  const details = Array.from(state.lossDetails.values());
  let payload = JSON.stringify({ ...base, details });
  let line = `[${observedAt}] ORCH: ${payload}\n`;
  if (Buffer.byteLength(line) > maxBufferedBytes) {
    payload = JSON.stringify(base);
    line = `[${observedAt}] ORCH: ${payload}\n`;
  }
  return {
    id: state.nextId,
    stream: "orchestration",
    threadSegment: GLOBAL_THREAD_SEGMENT,
    line,
    bytes: Buffer.byteLength(line),
    priority: "protected",
    lossSummary: true,
  };
}

function materializeLossSummary(
  state: StoreState,
  observedAt: string,
  options: ResolvedOptions,
): StoreState {
  if (!state.summaryPending || state.submissions.length > 0) return state;
  const existingIndex = state.pending.findIndex((record) => record.lossSummary);
  const summary = makeLossSummaryRecord(state, observedAt, options.maxBufferedBytes);

  if (existingIndex >= state.inFlightRecords && existingIndex >= 0) {
    const existing = state.pending[existingIndex];
    if (!existing) return state;
    const replacement = { ...summary, id: existing.id };
    const pendingBytes = state.pendingBytes - existing.bytes + replacement.bytes;
    if (pendingBytes > options.maxBufferedBytes) return state;
    const pending = [...state.pending];
    pending[existingIndex] = replacement;
    return {
      ...state,
      pending,
      pendingBytes,
      unsummarizedLossCounts: { lowValue: 0, protected: 0 },
      lossDetails: new Map(),
      summaryPending: false,
    };
  }
  if (existingIndex >= 0 || !canFitRecord(state, summary.bytes, options)) return state;
  return {
    ...state,
    pending: [...state.pending, summary],
    pendingBytes: state.pendingBytes + summary.bytes,
    nextId: state.nextId + 1,
    unsummarizedLossCounts: { lowValue: 0, protected: 0 },
    lossDetails: new Map(),
    summaryPending: false,
  };
}

function takeIdleWaiters(
  state: StoreState,
): readonly [ReadonlyArray<Deferred.Deferred<void>>, StoreState] {
  if (
    state.pending.length > 0 ||
    state.submissions.length > 0 ||
    state.summaryPending ||
    state.inFlightRecords > 0 ||
    state.inFlightSubmission
  ) {
    return [[], state];
  }
  return [state.drainWaiters, { ...state, drainWaiters: [] }];
}

const serializeEvent = Effect.fnUntraced(function* (event: unknown) {
  return yield* encodeUnknownJsonString(event).pipe(
    Effect.catch((error) =>
      logWarning("failed to serialize provider event log record", {
        errorTag: errorTag(error),
      }).pipe(Effect.as(undefined)),
    ),
  );
});

export const makeEventNdjsonLogStore = Effect.fnUntraced(function* (
  filePath: string,
  options: EventNdjsonLogStoreOptions = {},
): Effect.fn.Return<EventNdjsonLogStore, EventNdjsonLogStoreError> {
  const resolved = yield* resolveOptions(filePath, options);
  const directory = NodePath.dirname(filePath);
  const filePrefix = providerLogPrefix(filePath);

  yield* Effect.try({
    try: () => NodeFS.mkdirSync(directory, { recursive: true }),
    catch: (cause) => new EventNdjsonLogDirectoryError({ directory, cause }),
  });

  const initializedAt = yield* Clock.currentTimeMillis;
  const initialRetention = yield* Effect.sync(() =>
    enforceRetention({
      directory,
      maxTotalBytes: resolved.maxTotalBytes,
      maxAgeMs: resolved.maxAgeMs,
      activeFilePaths: new Set(),
      filePrefix,
      now: initializedAt,
    }),
  );
  for (const failure of initialRetention.failures) {
    yield* logWarning("provider event log retention failed", {
      filePath: failure.filePath,
      errorTag: errorTag(failure.cause),
    });
  }

  const stateRef = yield* SynchronizedRef.make<StoreState>({
    pending: [],
    submissions: [],
    pendingBytes: 0,
    sinks: new Map(),
    inFlightRecords: 0,
    inFlightSubmission: false,
    closed: false,
    nextId: 1,
    lastRetentionAt: initializedAt,
    lossCounts: { lowValue: 0, protected: 0 },
    unsummarizedLossCounts: { lowValue: 0, protected: 0 },
    lossDetails: new Map(),
    summaryPending: false,
    drainWaiters: [],
  });
  const sinkWake = yield* Queue.sliding<void>(1);
  const submissionWake = yield* Queue.sliding<void>(1);
  const closeRequested = yield* Deferred.make<void>();
  const closeDone = yield* Deferred.make<void>();
  const workerScope = yield* Scope.make();

  const completeWaiters = (waiters: ReadonlyArray<Deferred.Deferred<void>>) =>
    Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter, undefined), { discard: true });

  const diagnoseProtectedRejection = (
    reason: "protected-buffer-full",
    counts: EventNdjsonAdmissionCounts,
  ) =>
    logWarning("provider event log record rejected", {
      reason,
      pendingRecords: counts.pendingRecords,
      pendingBytes: counts.pendingBytes,
      lossCounts: counts.lossCounts,
    });

  const admitSerialized = Effect.fnUntraced(function* (input: {
    readonly stream: EventNdjsonStream;
    readonly threadSegment: string;
    readonly category: string;
    readonly priority: "low-value" | "protected";
    readonly observedAt: string;
    readonly line: string;
    readonly bytes: number;
    readonly submissionId?: number;
  }) {
    type AdmitAction = {
      readonly admission: EventNdjsonAdmission;
      readonly diagnose: boolean;
      readonly wake: boolean;
    };
    const action = yield* SynchronizedRef.modify(
      stateRef,
      (current): readonly [AdmitAction, StoreState] => {
        let state = current;
        if (input.submissionId !== undefined) {
          const submissionIndex = state.submissions.findIndex(
            (submission) => submission.id === input.submissionId,
          );
          if (submissionIndex < 0) {
            return [
              {
                admission: {
                  _tag: "Rejected",
                  reason: "closed",
                  ...admissionCounts(state),
                } satisfies EventNdjsonAdmission,
                diagnose: false,
                wake: false,
              },
              { ...state, inFlightSubmission: false },
            ] as const;
          }
          state = {
            ...state,
            submissions: state.submissions.filter((_, index) => index !== submissionIndex),
            inFlightSubmission: false,
          };
        } else if (state.closed) {
          return [
            {
              admission: {
                _tag: "Rejected",
                reason: "closed",
                ...admissionCounts(state),
              } satisfies EventNdjsonAdmission,
              diagnose: false,
              wake: false,
            },
            state,
          ] as const;
        }

        if (input.submissionId === undefined && state.summaryPending) {
          state = materializeLossSummary(state, input.observedAt, resolved);
          if (state.summaryPending) {
            state = recordLoss(state, input.priority, input.threadSegment, input.category);
            const counts = admissionCounts(state);
            const reason =
              input.priority === "protected" ? "protected-buffer-full" : "low-value-buffer-full";
            return [
              {
                admission: { _tag: "Rejected", reason, ...counts } satisfies EventNdjsonAdmission,
                diagnose: input.priority === "protected",
                wake: state.pending.length > 0,
              },
              state,
            ] as const;
          }
        }

        while (!canFitRecord(state, input.bytes, resolved) && input.priority === "protected") {
          const evicted = evictOldestLowValue(state);
          if (!evicted) break;
          state = evicted;
        }
        if (!canFitRecord(state, input.bytes, resolved)) {
          state = recordLoss(state, input.priority, input.threadSegment, input.category);
          const counts = admissionCounts(state);
          const reason =
            input.priority === "protected" ? "protected-buffer-full" : "low-value-buffer-full";
          return [
            {
              admission: { _tag: "Rejected", reason, ...counts } satisfies EventNdjsonAdmission,
              diagnose: input.priority === "protected",
              wake: state.pending.length > 0,
            },
            state,
          ] as const;
        }

        const id = input.submissionId ?? state.nextId;
        const record: QueuedRecord = {
          id,
          stream: input.stream,
          threadSegment: input.threadSegment,
          line: input.line,
          bytes: input.bytes,
          priority: input.priority,
          lossSummary: false,
        };
        state = {
          ...state,
          pending: [...state.pending, record].toSorted((left, right) => left.id - right.id),
          pendingBytes: state.pendingBytes + input.bytes,
          nextId: input.submissionId === undefined ? state.nextId + 1 : state.nextId,
        };
        return [
          {
            admission: {
              _tag: "Accepted",
              ...admissionCounts(state),
            } satisfies EventNdjsonAdmission,
            diagnose: false,
            wake: true,
          },
          state,
        ] as const;
      },
    );

    if (action.wake) yield* Queue.offer(sinkWake, undefined);
    if (action.diagnose && action.admission._tag === "Rejected") {
      yield* diagnoseProtectedRejection("protected-buffer-full", action.admission);
    }
    return action.admission;
  });

  const removeFailedSubmission = Effect.fnUntraced(function* (submission: PendingSubmission) {
    const action = yield* SynchronizedRef.modify(stateRef, (state) => {
      if (!state.submissions.some((entry) => entry.id === submission.id)) {
        return [
          { diagnose: false, wake: false },
          { ...state, inFlightSubmission: false },
        ] as const;
      }
      let next: StoreState = {
        ...state,
        submissions: state.submissions.filter((entry) => entry.id !== submission.id),
        inFlightSubmission: false,
      };
      next = recordLoss(next, submission.priority, submission.threadSegment, submission.category);
      return [
        {
          diagnose: submission.priority === "protected",
          wake: next.pending.length > 0 || next.summaryPending,
        },
        next,
      ] as const;
    });
    if (action.wake) yield* Queue.offer(sinkWake, undefined);
    if (action.diagnose) {
      const state = yield* SynchronizedRef.get(stateRef);
      yield* diagnoseProtectedRejection("protected-buffer-full", admissionCounts(state));
    }
  });

  const runSubmission = Effect.fnUntraced(function* (submission: PendingSubmission) {
    const payload = yield* serializeEvent(submission.event);
    if (payload === undefined) {
      yield* removeFailedSubmission(submission);
      return;
    }
    const observedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const line = `[${observedAt}] ${resolveStreamLabel(submission.stream)}: ${payload}\n`;
    yield* admitSerialized({
      stream: submission.stream,
      threadSegment: submission.threadSegment,
      category: submission.category,
      priority: submission.priority,
      observedAt,
      line,
      bytes: Buffer.byteLength(line),
      submissionId: submission.id,
    });
  });

  const submissionWorker = Effect.gen(function* () {
    while (true) {
      yield* Queue.take(submissionWake);
      while (true) {
        const submission = yield* SynchronizedRef.modify(stateRef, (state) => {
          if (state.inFlightSubmission || state.submissions.length === 0) {
            return [undefined, state] as const;
          }
          return [state.submissions[0], { ...state, inFlightSubmission: true }] as const;
        });
        if (!submission) break;
        yield* runSubmission(submission).pipe(
          Effect.catchCause((cause) =>
            logWarning("provider event log admission worker failed", {
              errorTag: causeErrorTag(cause),
            }).pipe(Effect.andThen(removeFailedSubmission(submission))),
          ),
        );
      }
      yield* Queue.offer(sinkWake, undefined);
      const state = yield* SynchronizedRef.get(stateRef);
      if (state.closed && state.submissions.length === 0) {
        yield* Queue.offer(sinkWake, undefined);
      }
    }
  });

  const prepareBatch = Effect.fnUntraced(function* () {
    const observedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    type PreparedBatch =
      | {
          readonly _tag: "Blocked" | "Empty";
          readonly waiters: ReadonlyArray<Deferred.Deferred<void>>;
        }
      | {
          readonly _tag: "Batch";
          readonly records: ReadonlyArray<QueuedRecord>;
          readonly waiters: ReadonlyArray<Deferred.Deferred<void>>;
        };
    const action = yield* SynchronizedRef.modify(
      stateRef,
      (current): readonly [PreparedBatch, StoreState] => {
        let state = materializeLossSummary(current, observedAt, resolved);
        if (state.inFlightRecords > 0) {
          return [{ _tag: "Blocked" as const, waiters: [] }, state] as const;
        }
        const first = state.pending[0];
        const firstSubmission = state.submissions[0];
        if (!first || (firstSubmission && firstSubmission.id < first.id)) {
          const [waiters, next] = takeIdleWaiters(state);
          return [
            {
              _tag: firstSubmission ? ("Blocked" as const) : ("Empty" as const),
              waiters,
            },
            next,
          ] as const;
        }

        const records: Array<QueuedRecord> = [];
        let bytes = 0;
        for (const record of state.pending) {
          if (record.threadSegment !== first.threadSegment) break;
          if (firstSubmission && record.id > firstSubmission.id) break;
          if (bytes > 0 && bytes + record.bytes > resolved.maxBytes) break;
          records.push(record);
          bytes += record.bytes;
          if (bytes >= resolved.maxBytes) break;
        }
        return [
          { _tag: "Batch" as const, records, waiters: [] },
          { ...state, inFlightRecords: records.length },
        ] as const;
      },
    );
    yield* completeWaiters(action.waiters);
    return action;
  });

  const getSink = Effect.fnUntraced(function* (threadSegment: string) {
    const existing = (yield* SynchronizedRef.get(stateRef)).sinks.get(threadSegment);
    if (existing) return existing;
    const ownedPath = providerLogPath(directory, filePrefix, threadSegment);
    const sink = yield* Effect.sync(() =>
      resolved.sinkFactory({
        filePath: ownedPath,
        maxBytes: resolved.maxBytes,
        maxFiles: resolved.maxFiles,
      }),
    );
    yield* SynchronizedRef.update(stateRef, (state) => ({
      ...state,
      sinks: new Map(state.sinks).set(threadSegment, sink),
    }));
    return sink;
  });

  const recordAttribution = Effect.fnUntraced(function* (
    records: ReadonlyArray<QueuedRecord>,
    durationMs: number,
  ) {
    if (!resolved.attribution) return;
    const byStream = new Map<EventNdjsonStream, AttributionSummary>();
    for (const record of records) {
      const current = byStream.get(record.stream) ?? {
        stream: record.stream,
        count: 0,
        logicalWriteBytes: 0,
      };
      byStream.set(record.stream, {
        stream: record.stream,
        count: current.count + 1,
        logicalWriteBytes: current.logicalWriteBytes + record.bytes,
      });
    }
    const totalBytes = records.reduce((total, record) => total + record.bytes, 0);
    yield* Effect.forEach(
      byStream.values(),
      (entry) =>
        resolved.attribution?.record({
          component: "provider-event-log",
          operation: `${entry.stream}.append`,
          logicalWriteBytes: entry.logicalWriteBytes,
          count: entry.count,
          durationMs:
            totalBytes === 0 ? 0 : Math.round(durationMs * (entry.logicalWriteBytes / totalBytes)),
        }) ?? Effect.void,
      { discard: true },
    );
  });

  const enforceRetentionIfDue = Effect.fnUntraced(function* () {
    const now = yield* Clock.currentTimeMillis;
    const snapshot = yield* SynchronizedRef.modify(stateRef, (state) => {
      if (now - state.lastRetentionAt < resolved.retentionCheckIntervalMs) {
        return [undefined, state] as const;
      }
      return [state.sinks, { ...state, lastRetentionAt: now }] as const;
    });
    if (!snapshot) return;
    const result = yield* Effect.sync(() =>
      enforceRetention({
        directory,
        maxTotalBytes: resolved.maxTotalBytes,
        maxAgeMs: resolved.maxAgeMs,
        activeFilePaths: new Set(
          Array.from(snapshot.keys(), (threadSegment) =>
            providerLogPath(directory, filePrefix, threadSegment),
          ),
        ),
        filePrefix,
        now,
      }),
    );
    for (const failure of result.failures) {
      yield* logWarning("provider event log retention failed", {
        filePath: failure.filePath,
        errorTag: errorTag(failure.cause),
      });
    }
  });

  const acknowledgeBatch = Effect.fnUntraced(function* (records: ReadonlyArray<QueuedRecord>) {
    const waiters = yield* SynchronizedRef.modify(stateRef, (state) => {
      const ids = new Set(records.map((record) => record.id));
      const pending = state.pending.filter((record) => !ids.has(record.id));
      const next = {
        ...state,
        pending,
        pendingBytes:
          state.pendingBytes - records.reduce((total, record) => total + record.bytes, 0),
        inFlightRecords: 0,
      };
      return takeIdleWaiters(next);
    });
    yield* completeWaiters(waiters);
    yield* Queue.offer(sinkWake, undefined);
  });

  const failBatch = Effect.fnUntraced(function* (threadSegment: string, cause: unknown) {
    const ownedPath = providerLogPath(directory, filePrefix, threadSegment);
    yield* SynchronizedRef.update(stateRef, (state) => {
      const sinks = new Map(state.sinks);
      sinks.delete(threadSegment);
      return { ...state, sinks, inFlightRecords: 0 };
    });
    yield* logWarning("provider event log write failed", {
      filePath: ownedPath,
      errorTag: errorTag(cause),
    });
  });

  const drainOne = Effect.fnUntraced(function* () {
    const prepared = yield* prepareBatch();
    if (prepared._tag !== "Batch") return prepared._tag;
    const first = prepared.records[0];
    if (!first) return "Empty" as const;
    const startedAt = yield* Clock.currentTimeMillis;
    const writeExit = yield* Effect.exit(
      getSink(first.threadSegment).pipe(
        Effect.flatMap((sink) =>
          sink.write(prepared.records.map((record) => record.line).join("")),
        ),
      ),
    );
    if (Exit.isFailure(writeExit)) {
      yield* failBatch(first.threadSegment, writeExit.cause);
      return "Failed" as const;
    }
    const completedAt = yield* Clock.currentTimeMillis;
    yield* acknowledgeBatch(prepared.records);
    yield* recordAttribution(prepared.records, Math.max(0, completedAt - startedAt));
    yield* enforceRetentionIfDue();
    return "Written" as const;
  });

  const sinkWorker = Effect.gen(function* () {
    while (true) {
      yield* Queue.take(sinkWake);
      if (!(yield* Deferred.isDone(closeRequested)) && resolved.batchWindowMs > 0) {
        yield* Deferred.await(closeRequested).pipe(
          Effect.timeoutOption(resolved.batchWindowMs),
          Effect.asVoid,
        );
      }
      while (true) {
        const result = yield* drainOne();
        if (result === "Written") continue;
        if (result === "Failed") {
          yield* Effect.sleep(resolved.retryDelayMs);
          continue;
        }
        break;
      }
      const state = yield* SynchronizedRef.get(stateRef);
      if (
        state.closed &&
        state.pending.length === 0 &&
        state.submissions.length === 0 &&
        !state.summaryPending
      ) {
        yield* Deferred.succeed(closeDone, undefined);
        return;
      }
    }
  });

  const submissionFiber = yield* Effect.forkIn(submissionWorker, workerScope);
  const sinkFiber = yield* Effect.forkIn(sinkWorker, workerScope);

  const drain = Effect.fnUntraced(function* () {
    const waiter = yield* Deferred.make<void>();
    const wait = yield* SynchronizedRef.modify(stateRef, (state) => {
      if (
        state.pending.length === 0 &&
        state.submissions.length === 0 &&
        !state.summaryPending &&
        state.inFlightRecords === 0 &&
        !state.inFlightSubmission
      ) {
        return [false, state] as const;
      }
      return [true, { ...state, drainWaiters: [...state.drainWaiters, waiter] }] as const;
    });
    if (!wait) return;
    yield* Queue.offer(submissionWake, undefined);
    yield* Queue.offer(sinkWake, undefined);
    yield* Deferred.await(waiter);
  });

  const close = Effect.fnUntraced(function* () {
    yield* SynchronizedRef.update(stateRef, (state) => ({ ...state, closed: true }));
    yield* Deferred.succeed(closeRequested, undefined);
    yield* Queue.offer(submissionWake, undefined);
    yield* Queue.offer(sinkWake, undefined);
    const completed = yield* Deferred.await(closeDone).pipe(
      Effect.timeoutOption(resolved.closeTimeoutMs),
    );
    if (Option.isSome(completed)) return;

    const state = yield* SynchronizedRef.get(stateRef);
    const timeout = new EventNdjsonLogCloseTimeout({
      filePath,
      timeoutMs: resolved.closeTimeoutMs,
      pendingRecords: pendingRecordCount(state),
      pendingBytes: state.pendingBytes,
      lossCounts: state.lossCounts,
    });
    yield* logWarning("provider event log close timed out", {
      reason: "close-timeout",
      pendingRecords: timeout.pendingRecords,
      pendingBytes: timeout.pendingBytes,
      lossCounts: timeout.lossCounts,
    });
    yield* Fiber.interrupt(submissionFiber);
    yield* Fiber.interrupt(sinkFiber);
    return yield* timeout;
  });

  const loggerViews = new Map<EventNdjsonStream, EventNdjsonLogger>();
  const logger = (stream: EventNdjsonStream): EventNdjsonLogger => {
    const existing = loggerViews.get(stream);
    if (existing) return existing;

    const write = Effect.fnUntraced(function* (event: unknown, threadId: ThreadId | null) {
      if (!shouldPersist(stream, event)) {
        const state = yield* SynchronizedRef.get(stateRef);
        return {
          _tag: "Rejected",
          reason: "filtered",
          ...admissionCounts(state),
        } satisfies EventNdjsonAdmission;
      }
      const payload = yield* serializeEvent(event);
      if (payload === undefined) {
        const state = yield* SynchronizedRef.get(stateRef);
        return {
          _tag: "Rejected",
          reason: "serialization-failed",
          ...admissionCounts(state),
        } satisfies EventNdjsonAdmission;
      }

      const observedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const line = `[${observedAt}] ${resolveStreamLabel(stream)}: ${payload}\n`;
      return yield* admitSerialized({
        stream,
        threadSegment: resolveThreadSegment(threadId),
        category: eventCategory(event),
        priority: isLowValueEvent(stream, event) ? "low-value" : "protected",
        observedAt,
        line,
        bytes: Buffer.byteLength(line),
      });
    });

    const view = {
      filePath,
      write,
      drain,
      close: () => Effect.void,
    } satisfies EventNdjsonLogger;
    loggerViews.set(stream, view);
    return view;
  };

  return {
    filePath,
    logger,
    drain,
    close: () => close().pipe(Effect.catch(() => Effect.void)),
  } satisfies EventNdjsonLogStore;
});

export const makeEventNdjsonLogger = Effect.fnUntraced(function* (
  filePath: string,
  options: EventNdjsonLoggerOptions,
): Effect.fn.Return<EventNdjsonLogger | undefined> {
  const store = yield* makeEventNdjsonLogStore(filePath, options).pipe(
    Effect.catch((error) =>
      logWarning(error.message, { error }).pipe(
        Effect.as<EventNdjsonLogStore | undefined>(undefined),
      ),
    ),
  );
  if (!store) return undefined;
  return { ...store.logger(options.stream), close: store.close };
});
