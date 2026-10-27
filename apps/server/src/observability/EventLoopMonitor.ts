// @effect-diagnostics nodeBuiltinImport:off - only node:perf_hooks exposes the event loop delay histogram, and node:os the load average.
import * as NodeOS from "node:os";
import * as NodePerfHooks from "node:perf_hooks";

import type { ServerEventLoopStall } from "@t3tools/contracts";
import { RotatingFileSink } from "@t3tools/shared/logging";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Duration from "effect/Duration";
import { DEFAULT_PERFORMANCE_SETTINGS } from "@t3tools/contracts";
import { runtimePerformanceSettings } from "../performanceSettings.ts";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as Metrics from "./Metrics.ts";

// The timer stays native; subtract its interval to report excess event-loop delay.
const RESOLUTION_MS = 20;
const STALL_THRESHOLD_MS = 2000;
// A stall line is about 250 bytes, so the file and its one backup keep the last
// 1000 to 2000 stalls.
const STALL_LOG_MAX_BYTES = 256 * 1024;
// Long enough that users felt it. Shorter stalls stay in the log only.
const NOTICEABLE_STALL_MS = 5000;
// Clients show what they get, so an old stall must not explain a new drop.
const NOTICEABLE_STALL_MAX_AGE_MS = 5 * 60_000;

export class EventLoopMonitor extends Context.Reference<{
  /**
   * The latest stall of 5 s or more, if seen in the last 5 minutes. It samples
   * first, so a stall that ended just before a client reconnected is included.
   */
  readonly latestNoticeableStall: Effect.Effect<ServerEventLoopStall | undefined>;
}>("t3/observability/EventLoopMonitor", {
  // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
  defaultValue: () => ({ latestNoticeableStall: Effect.succeed(undefined) }),
}) {}

/** One sample interval as Node reports it. Delay in ns, active time in ms, CPU in µs. */
export interface EventLoopReadings {
  readonly delayMaxNs: number;
  readonly delayP95Ns: number;
  readonly delayP99Ns: number;
  readonly delayMeanNs: number;
  readonly activeMs: number;
  readonly utilization: number;
  readonly usage: Pick<
    NodeJS.ResourceUsage,
    | "userCPUTime"
    | "systemCPUTime"
    | "majorPageFault"
    | "minorPageFault"
    | "involuntaryContextSwitches"
  >;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  /** Wall time the readings cover. */
  readonly elapsedMs: number;
  /** One-minute load average, undefined on Windows. */
  readonly loadAverage: number | undefined;
  readonly cpuCount: number;
}

// Enables the delay histogram for the layer's lifetime. Each read returns the
// readings since the previous read and resets the histogram. Node skips the first
// gap after a reset, so a stall right at a sample boundary can be missed.
const makeNodeSampler = Effect.gen(function* () {
  const histogram = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const histogram = NodePerfHooks.monitorEventLoopDelay({ resolution: RESOLUTION_MS });
      histogram.enable();
      return histogram;
    }),
    (histogram) => Effect.sync(() => histogram.disable()),
  );
  let elu = NodePerfHooks.performance.eventLoopUtilization();
  let usage = process.resourceUsage();
  let sampledAt = NodePerfHooks.performance.now();

  return Effect.sync(() => {
    const nextElu = NodePerfHooks.performance.eventLoopUtilization();
    const nextUsage = process.resourceUsage();
    const nextSampledAt = NodePerfHooks.performance.now();
    const memory = process.memoryUsage();
    const loop = NodePerfHooks.performance.eventLoopUtilization(nextElu, elu);
    const readings: EventLoopReadings = {
      delayMaxNs: histogram.max,
      delayP95Ns: histogram.percentile(95),
      delayP99Ns: histogram.percentile(99),
      delayMeanNs: histogram.mean,
      activeMs: loop.active,
      utilization: loop.utilization,
      usage: {
        userCPUTime: nextUsage.userCPUTime - usage.userCPUTime,
        systemCPUTime: nextUsage.systemCPUTime - usage.systemCPUTime,
        majorPageFault: nextUsage.majorPageFault - usage.majorPageFault,
        minorPageFault: nextUsage.minorPageFault - usage.minorPageFault,
        involuntaryContextSwitches:
          nextUsage.involuntaryContextSwitches - usage.involuntaryContextSwitches,
      },
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      elapsedMs: nextSampledAt - sampledAt,
      // Windows has no load average and reports 0, which a running process never sees elsewhere.
      loadAverage: NodeOS.loadavg()[0] || undefined,
      cpuCount: NodeOS.availableParallelism(),
    };
    histogram.reset();
    elu = nextElu;
    usage = nextUsage;
    sampledAt = nextSampledAt;
    return readings;
  });
});

/**
 * Returns the stall to report for one sample in ms, or undefined when there was none.
 */
export const stallMs = ({ delayMaxNs, activeMs }: EventLoopReadings) => {
  const delayMs = Math.round(delayMaxNs / 1e6) - RESOLUTION_MS;
  // libuv clocks run during macOS/Windows sleep; idle poll time distinguishes it from stalls.
  if (delayMs <= STALL_THRESHOLD_MS || activeMs < delayMs) return undefined;
  return delayMs;
};

const excessDelayMs = (ns: number) =>
  Number.isFinite(ns) ? Math.max(0, Math.round((ns / 1e6 - RESOLUTION_MS) * 100) / 100) : 0;
// Untraced: it runs inside every 30-second tick, which already has the monitor's own span.
const recordGauges = Effect.fnUntraced(function* (readings: EventLoopReadings) {
  const cpuMs = (readings.usage.userCPUTime + readings.usage.systemCPUTime) / 1000;
  yield* Metric.update(Metrics.serverResidentBytes, readings.rssBytes);
  yield* Metric.update(Metrics.serverHeapUsedBytes, readings.heapUsedBytes);
  yield* Metric.update(Metrics.serverEventLoopUtilization, readings.utilization);
  yield* Metric.update(
    Metrics.serverEventLoopDelayMax,
    Math.max(0, Math.round(readings.delayMaxNs / 1e6) - RESOLUTION_MS),
  );
  if (readings.elapsedMs > 0) {
    yield* Metric.update(Metrics.serverCpuUtilization, cpuMs / readings.elapsedMs);
  }
});

const encodeStallLine = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export interface StallLogOptions {
  readonly filePath: string;
  readonly maxBytes: number;
}

/**
 * Samples event loop health at the configured interval and records a `server.eventLoop.stall` span
 * with a warning when the loop stalled for more than 2 s, so stalls land in
 * the local trace file and Settings > Diagnostics without OTLP. Each stall is
 * also appended as one NDJSON line to a small stall log, which keeps stall
 * history long after the trace file has rotated. Takes the sampler and log
 * options so tests can inject readings and a small cap.
 */
export const layerWith = (
  makeSampler: Effect.Effect<Effect.Effect<EventLoopReadings>, never, Scope.Scope>,
  options?: StallLogOptions | Effect.Effect<number>,
  configuredInterval?: Effect.Effect<number>,
) => {
  const stallLog = options && "filePath" in options ? options : undefined;
  const reportInterval =
    options && !("filePath" in options)
      ? options
      : (configuredInterval ??
        Effect.succeed(DEFAULT_PERFORMANCE_SETTINGS.eventLoopReportIntervalMs));
  return Layer.effect(
    EventLoopMonitor,
    Effect.gen(function* () {
      const sample = yield* makeSampler;
      // Clients sample on connect as well as the timer, and the sampler resets shared state.
      const sampling = yield* Semaphore.make(1);
      const warmedUp = yield* Ref.make(false);
      const latestNoticeableStall = yield* Ref.make<
        { readonly stall: ServerEventLoopStall; readonly detectedAtMs: number } | undefined
      >(undefined);
      const stallSink =
        stallLog === undefined
          ? undefined
          : yield* Effect.try(
              () =>
                new RotatingFileSink({
                  filePath: stallLog.filePath,
                  maxBytes: stallLog.maxBytes,
                  maxFiles: 1,
                  throwOnError: true,
                }),
            ).pipe(
              Effect.catch(() =>
                Effect.logWarning("event loop stall log unavailable", {
                  filePath: stallLog.filePath,
                }).pipe(Effect.as(undefined)),
              ),
            );
      const tick = Effect.gen(function* () {
        const readings = yield* sample;
        yield* recordGauges(readings);
        const idleGapDetected = readings.activeMs < excessDelayMs(readings.delayMaxNs);
        yield* Effect.void.pipe(
          Effect.withSpan("server.eventLoop.health", {
            root: true,
            level: "Info",
            attributes: {
              delayMaxMs: idleGapDetected ? 0 : excessDelayMs(readings.delayMaxNs),
              delayP95Ms: idleGapDetected ? 0 : excessDelayMs(readings.delayP95Ns),
              delayP99Ms: idleGapDetected ? 0 : excessDelayMs(readings.delayP99Ns),
              delayMeanMs: idleGapDetected ? 0 : excessDelayMs(readings.delayMeanNs),
              idleGapDetected,
              utilization: Math.round(readings.utilization * 1000) / 1000,
            },
          }),
        );
        const delayMaxMs = stallMs(readings);
        if (delayMaxMs === undefined) return;
        const { utilization, usage, rssBytes, loadAverage, cpuCount } = readings;
        const now = yield* DateTime.now;
        const detectedAt = DateTime.formatIso(now);
        if (delayMaxMs >= NOTICEABLE_STALL_MS) {
          yield* Ref.set(latestNoticeableStall, {
            detectedAtMs: DateTime.toEpochMillis(now),
            stall: {
              detectedAt,
              durationMs: delayMaxMs,
              ...(loadAverage === undefined
                ? {}
                : { loadAverage: Math.round(loadAverage * 10) / 10 }),
              cpuCount,
            },
          });
        }
        const attributes = {
          delayMaxMs,
          utilization: Math.round(utilization * 100) / 100,
          cpuUserMs: Math.round(usage.userCPUTime / 1000),
          cpuSystemMs: Math.round(usage.systemCPUTime / 1000),
          majorPageFaults: usage.majorPageFault,
          minorPageFaults: usage.minorPageFault,
          involuntaryContextSwitches: usage.involuntaryContextSwitches,
          rssMb: Math.round(rssBytes / 1024 / 1024),
        };
        // Root, as the stall has no caller to attach to. Warn level keeps it when
        // T3CODE_TRACE_MIN_LEVEL is raised to cut trace noise.
        yield* Effect.logWarning(`event loop stalled for ${delayMaxMs} ms`).pipe(
          Effect.withSpan("server.eventLoop.stall", { root: true, level: "Warn", attributes }),
        );
        if (stallSink !== undefined) {
          yield* encodeStallLine({ time: detectedAt, ...attributes }).pipe(
            Effect.flatMap((line) => Effect.try(() => stallSink.write(`${line}\n`))),
            Effect.catch(() =>
              Effect.logWarning("event loop stall log write failed", {
                filePath: stallLog?.filePath,
              }),
            ),
          );
        }
      }).pipe(sampling.withPermits(1));
      const wait = reportInterval.pipe(Effect.flatMap((ms) => Effect.sleep(Duration.millis(ms))));
      // The first sample includes migrations and bootstrap; skip expected startup stalls.
      yield* wait.pipe(
        Effect.andThen(sampling.withPermits(1)(sample)),
        Effect.andThen(Ref.set(warmedUp, true)),
        Effect.andThen(wait.pipe(Effect.andThen(tick), Effect.forever)),
        Effect.forkScoped,
      );

      return EventLoopMonitor.of({
        latestNoticeableStall: Effect.gen(function* () {
          if (yield* Ref.get(warmedUp)) yield* tick;
          const latest = yield* Ref.get(latestNoticeableStall);
          if (latest === undefined) return undefined;
          const ageMs = DateTime.toEpochMillis(yield* DateTime.now) - latest.detectedAtMs;
          return ageMs <= NOTICEABLE_STALL_MAX_AGE_MS ? latest.stall : undefined;
        }),
      });
    }),
  );
};

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { serverTracePath } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const settings = yield* runtimePerformanceSettings;
    return layerWith(
      makeNodeSampler,
      {
        filePath: path.join(path.dirname(serverTracePath), "event-loop-stalls.ndjson"),
        maxBytes: STALL_LOG_MAX_BYTES,
      },
      settings.pipe(Effect.map((value) => value.eventLoopReportIntervalMs)),
    );
  }),
);
