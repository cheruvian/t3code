import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import { RENDERER_HEARTBEAT_CHANNEL } from "../ipc/channels.ts";

export const HEARTBEAT_INTERVAL_MS = 1_000;
export const CHECK_INTERVAL_MS = 1_000;
export const STALL_THRESHOLD_MS = 6_000;
export const CAPTURE_DURATION_MS = 5_000;
export const MIN_CAPTURE_INTERVAL_MS = 300_000;
export const MAX_CAPTURES_PER_SESSION = 5;

const METADATA_KEYS = [
  "capturedAt",
  "stallDurationMs",
  "heartbeatIntervalMs",
  "missedHeartbeatCount",
  "captureDurationMs",
  "appVersion",
  "platform",
  "arch",
  "processUptimeSeconds",
  "sessionCaptureIndex",
] as const;

type HeartbeatEvent = { readonly sender: { readonly id: number } };
type HeartbeatListener = (event: HeartbeatEvent) => void;

export interface RendererStallTarget {
  readonly id: number;
  readonly isActive: () => boolean;
  readonly debugger: {
    readonly attach: (protocolVersion: string) => void;
    readonly isAttached: () => boolean;
    readonly detach: () => void;
    readonly sendCommand: (method: string) => Promise<unknown>;
  };
}

export interface RendererStallWatchdogDependencies {
  readonly ipcMain: {
    readonly on: (channel: string, listener: HeartbeatListener) => void;
    readonly removeListener: (channel: string, listener: HeartbeatListener) => void;
  };
  readonly fileSystem: {
    readonly makeDirectory: (path: string) => Effect.Effect<void>;
    readonly writeFileString: (path: string, contents: string) => Effect.Effect<void>;
  };
  readonly diagnosticsDir: string;
  readonly appVersion: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly processUptime: () => number;
}

export function evaluateStall(input: {
  readonly active: boolean;
  readonly lastHeartbeatAt: number;
  readonly now: number;
  readonly stallThresholdMs: number;
}): boolean {
  return input.active && input.now - input.lastHeartbeatAt >= input.stallThresholdMs;
}

export function evaluateCaptureAllowed(input: {
  readonly now: number;
  readonly lastCaptureAt: number | undefined;
  readonly minIntervalMs: number;
  readonly capturesThisSession: number;
  readonly maxCaptures: number;
  readonly captureInProgress: boolean;
}): boolean {
  return (
    !input.captureInProgress &&
    input.capturesThisSession < input.maxCaptures &&
    (input.lastCaptureAt === undefined || input.now - input.lastCaptureAt >= input.minIntervalMs)
  );
}

export class RendererStallWatchdog extends Context.Service<
  RendererStallWatchdog,
  {
    readonly watch: (target: RendererStallTarget) => Effect.Effect<never>;
  }
>()("@t3tools/desktop/diagnostics/RendererStallWatchdog") {}

export function installRendererStallWatchdog(input: {
  readonly enabled: boolean;
  readonly watchdog: RendererStallWatchdog["Service"];
  readonly target: RendererStallTarget;
  readonly runFork: (effect: Effect.Effect<never>) => Fiber.Fiber<never>;
}): Fiber.Fiber<never> | undefined {
  return input.enabled ? input.runFork(input.watchdog.watch(input.target)) : undefined;
}

const { logInfo, logWarning } = makeComponentLogger("renderer-stall-watchdog");

const RendererStallMetadata = Schema.Struct({
  capturedAt: Schema.String,
  stallDurationMs: Schema.Number,
  heartbeatIntervalMs: Schema.Number,
  missedHeartbeatCount: Schema.Number,
  captureDurationMs: Schema.Number,
  appVersion: Schema.String,
  platform: Schema.String,
  arch: Schema.String,
  processUptimeSeconds: Schema.Number,
  sessionCaptureIndex: Schema.Number,
});
const encodeMetadata = Schema.encodeSync(Schema.fromJsonString(RendererStallMetadata));
const encodeProfile = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const attempt = <A>(evaluate: () => A): Effect.Effect<A> => Effect.try(evaluate).pipe(Effect.orDie);

const attemptPromise = <A>(evaluate: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(evaluate).pipe(Effect.orDie);

export function makeRendererStallWatchdog(
  dependencies: RendererStallWatchdogDependencies,
): RendererStallWatchdog["Service"] {
  const capture = Effect.fn("rendererStallWatchdog.capture")(function* (
    target: RendererStallTarget,
    input: {
      readonly capturedAt: number;
      readonly stallDurationMs: number;
      readonly sessionCaptureIndex: number;
    },
  ) {
    const capturedAt = DateTime.formatIso(DateTime.makeUnsafe(input.capturedAt));
    const basename = `renderer-stall-${capturedAt.replaceAll(":", "-")}`;
    const profilePath = `${dependencies.diagnosticsDir}/${basename}.cpuprofile`;
    const metadataPath = `${dependencies.diagnosticsDir}/${basename}.json`;

    yield* attempt(() => target.debugger.attach("1.3"));
    yield* attemptPromise(() => target.debugger.sendCommand("Profiler.enable"));
    yield* attemptPromise(() => target.debugger.sendCommand("Profiler.start"));
    yield* Effect.sleep(CAPTURE_DURATION_MS);
    const result = yield* attemptPromise(() => target.debugger.sendCommand("Profiler.stop"));
    yield* attemptPromise(() => target.debugger.sendCommand("Profiler.disable"));
    const profile =
      typeof result === "object" && result !== null && "profile" in result
        ? result.profile
        : result;
    const metadata = {
      capturedAt,
      stallDurationMs: input.stallDurationMs,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      missedHeartbeatCount: Math.floor(input.stallDurationMs / HEARTBEAT_INTERVAL_MS),
      captureDurationMs: CAPTURE_DURATION_MS,
      appVersion: dependencies.appVersion,
      platform: dependencies.platform,
      arch: dependencies.arch,
      processUptimeSeconds: Math.floor(dependencies.processUptime()),
      sessionCaptureIndex: input.sessionCaptureIndex,
    } satisfies Record<(typeof METADATA_KEYS)[number], string | number>;

    yield* dependencies.fileSystem.makeDirectory(dependencies.diagnosticsDir);
    yield* dependencies.fileSystem.writeFileString(profilePath, encodeProfile(profile));
    yield* dependencies.fileSystem.writeFileString(metadataPath, `${encodeMetadata(metadata)}\n`);
    yield* logInfo("renderer stall CPU profile captured", {
      profilePath,
      metadataPath,
      stallDurationMs: input.stallDurationMs,
      sessionCaptureIndex: input.sessionCaptureIndex,
    });
  });

  const watch = Effect.fn("rendererStallWatchdog.watch")(function* (
    target: RendererStallTarget,
  ): Effect.fn.Return<never> {
    let heartbeatPending = false;
    let lastHeartbeatAt = yield* Clock.currentTimeMillis;
    let lastCaptureAt: number | undefined;
    let capturesThisSession = 0;
    let captureInProgress = false;
    const listener: HeartbeatListener = (event) => {
      if (event.sender.id === target.id) heartbeatPending = true;
    };

    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => dependencies.ipcMain.on(RENDERER_HEARTBEAT_CHANNEL, listener)),
          () =>
            Effect.sync(() =>
              dependencies.ipcMain.removeListener(RENDERER_HEARTBEAT_CHANNEL, listener),
            ),
        );
        return yield* Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep(CHECK_INTERVAL_MS);
            const now = yield* Clock.currentTimeMillis;
            const active = target.isActive();
            if (!active) {
              heartbeatPending = false;
              lastHeartbeatAt = now;
              return;
            }
            if (heartbeatPending) {
              heartbeatPending = false;
              lastHeartbeatAt = now;
              return;
            }
            if (
              !evaluateStall({
                active,
                lastHeartbeatAt,
                now,
                stallThresholdMs: STALL_THRESHOLD_MS,
              }) ||
              !evaluateCaptureAllowed({
                now,
                lastCaptureAt,
                minIntervalMs: MIN_CAPTURE_INTERVAL_MS,
                capturesThisSession,
                maxCaptures: MAX_CAPTURES_PER_SESSION,
                captureInProgress,
              })
            ) {
              return;
            }

            lastCaptureAt = now;
            capturesThisSession += 1;
            captureInProgress = true;
            yield* capture(target, {
              capturedAt: now,
              stallDurationMs: now - lastHeartbeatAt,
              sessionCaptureIndex: capturesThisSession,
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (target.debugger.isAttached()) target.debugger.detach();
                  captureInProgress = false;
                }),
              ),
              Effect.catchCause((cause) =>
                logWarning("renderer stall CPU profile capture failed", {
                  cause,
                  stallDurationMs: now - lastHeartbeatAt,
                  sessionCaptureIndex: capturesThisSession,
                }),
              ),
            );
          }),
        );
      }),
    );
  });

  return RendererStallWatchdog.of({ watch });
}

export const layer = (ipcMain: typeof Electron.ipcMain) =>
  Layer.effect(
    RendererStallWatchdog,
    Effect.gen(function* () {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      const fileSystem = yield* FileSystem.FileSystem;
      return makeRendererStallWatchdog({
        ipcMain,
        fileSystem: {
          makeDirectory: (path) =>
            fileSystem.makeDirectory(path, { recursive: true }).pipe(Effect.orDie),
          writeFileString: (path, contents) =>
            fileSystem.writeFileString(path, contents).pipe(Effect.orDie),
        },
        diagnosticsDir: environment.path.join(
          environment.stateDir,
          "diagnostics",
          "renderer-stalls",
        ),
        appVersion: environment.appVersion,
        platform: environment.platform,
        arch: environment.processArch,
        processUptime: () => process.uptime(),
      });
    }),
  );
