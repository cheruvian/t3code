import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  CAPTURE_DURATION_MS,
  CHECK_INTERVAL_MS,
  MAX_CAPTURES_PER_SESSION,
  MIN_CAPTURE_INTERVAL_MS,
  STALL_THRESHOLD_MS,
  installRendererStallWatchdog,
  makeRendererStallWatchdog,
  type RendererStallWatchdogDependencies,
} from "./RendererStallWatchdog.ts";

const senderId = 42;
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function makeHarness(options?: { readonly failFirstStop?: boolean }) {
  const commands: string[] = [];
  const writes = new Map<string, string>();
  let listener: ((event: { readonly sender: { readonly id: number } }) => void) | undefined;
  let attached = false;
  let active = true;
  let stopFailuresRemaining = options?.failFirstStop === true ? 1 : 0;
  const powerListeners = new Map<string, () => void>();

  const dependencies: RendererStallWatchdogDependencies = {
    ipcMain: {
      on: (_channel, nextListener) => {
        listener = nextListener;
      },
      removeListener: (_channel, removedListener) => {
        if (listener === removedListener) listener = undefined;
      },
    },
    fileSystem: {
      makeDirectory: () => Effect.void,
      writeFileString: (path, contents) =>
        Effect.sync(() => {
          writes.set(path, contents);
        }),
    },
    diagnosticsDir: "/state/diagnostics/renderer-stalls",
    appVersion: "1.2.3",
    platform: "darwin",
    arch: "arm64",
    processUptime: () => 123,
    onPowerEvent: (eventName, powerListener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          powerListeners.set(eventName, powerListener);
        }),
        () =>
          Effect.sync(() => {
            powerListeners.delete(eventName);
          }),
      ).pipe(Effect.asVoid),
  };
  const target = {
    id: senderId,
    isActive: () => active,
    debugger: {
      attach: () => {
        commands.push("attach");
        attached = true;
      },
      isAttached: () => attached,
      detach: () => {
        commands.push("detach");
        attached = false;
      },
      sendCommand: (method: string) => {
        commands.push(method);
        if (method === "Profiler.stop" && stopFailuresRemaining > 0) {
          stopFailuresRemaining -= 1;
          return Promise.reject(new Error("stop failed"));
        }
        return Promise.resolve(method === "Profiler.stop" ? { profile: { nodes: [] } } : {});
      },
    },
  };

  return {
    commands,
    writes,
    target,
    dependencies,
    setActive: (next: boolean) => {
      active = next;
    },
    heartbeat: (id = senderId) => listener?.({ sender: { id } }),
    powerEvent: (eventName: "lock-screen" | "unlock-screen" | "suspend" | "resume") =>
      powerListeners.get(eventName)?.(),
    hasListener: () => listener !== undefined,
    isAttached: () => attached,
  };
}

const advance = (milliseconds: number) =>
  TestClock.adjust(Duration.millis(milliseconds)).pipe(Effect.andThen(Effect.yieldNow));

describe("RendererStallWatchdog", () => {
  it("does not start a fiber or register IPC when disabled", () => {
    const harness = makeHarness();
    let forked = false;
    const fiber = installRendererStallWatchdog({
      enabled: false,
      watchdog: makeRendererStallWatchdog(harness.dependencies),
      target: harness.target,
      runFork: () => {
        forked = true;
        throw new Error("disabled watchdog must not fork");
      },
    });

    assert.isUndefined(fiber);
    assert.isFalse(forked);
    assert.isFalse(harness.hasListener());
  });

  it.effect("captures one bounded CPU profile after a sustained active stall", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const watchdog = makeRendererStallWatchdog(harness.dependencies);
      const fiber = yield* watchdog
        .watch(harness.target)
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* advance(STALL_THRESHOLD_MS + CHECK_INTERVAL_MS);
      assert.deepEqual(harness.commands, ["attach", "Profiler.enable", "Profiler.start"]);
      yield* advance(CAPTURE_DURATION_MS);

      assert.deepEqual(harness.commands, [
        "attach",
        "Profiler.enable",
        "Profiler.start",
        "Profiler.stop",
        "Profiler.disable",
        "detach",
      ]);
      assert.equal(
        [...harness.writes.keys()].filter((path) => path.endsWith(".cpuprofile")).length,
        1,
      );
      assert.equal([...harness.writes.keys()].filter((path) => path.endsWith(".json")).length, 1);
      yield* Fiber.interrupt(fiber);
      assert.isFalse(harness.hasListener());
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("ignores hidden windows and heartbeats from other renderers", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      harness.setActive(false);
      const fiber = yield* makeRendererStallWatchdog(harness.dependencies)
        .watch(harness.target)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* advance(STALL_THRESHOLD_MS + CHECK_INTERVAL_MS);
      assert.deepEqual(harness.commands, []);

      harness.setActive(true);
      harness.heartbeat(senderId + 1);
      yield* advance(CHECK_INTERVAL_MS);
      assert.deepEqual(harness.commands, []);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("resets the heartbeat baseline across suspend and resume", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const fiber = yield* makeRendererStallWatchdog(harness.dependencies)
        .watch(harness.target)
        .pipe(Effect.forkChild({ startImmediately: true }));

      harness.powerEvent("suspend");
      yield* advance(STALL_THRESHOLD_MS * 10);
      assert.deepEqual(harness.commands, []);

      harness.powerEvent("resume");
      yield* advance(CHECK_INTERVAL_MS);
      assert.deepEqual(harness.commands, []);
      yield* advance(STALL_THRESHOLD_MS - CHECK_INTERVAL_MS);
      assert.deepEqual(harness.commands, []);

      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("rate-limits a persistent stall and caps captures for the session", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const fiber = yield* makeRendererStallWatchdog(harness.dependencies)
        .watch(harness.target)
        .pipe(Effect.forkChild({ startImmediately: true }));

      for (let index = 0; index < MAX_CAPTURES_PER_SESSION + 1; index += 1) {
        yield* advance(
          index === 0 ? STALL_THRESHOLD_MS + CHECK_INTERVAL_MS : MIN_CAPTURE_INTERVAL_MS,
        );
        yield* advance(CAPTURE_DURATION_MS);
      }

      assert.equal(
        harness.commands.filter((command) => command === "attach").length,
        MAX_CAPTURES_PER_SESSION,
      );
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("detaches after failure and captures again after the rate-limit interval", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ failFirstStop: true });
      const fiber = yield* makeRendererStallWatchdog(harness.dependencies)
        .watch(harness.target)
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* advance(STALL_THRESHOLD_MS + CHECK_INTERVAL_MS);
      yield* advance(CAPTURE_DURATION_MS);
      assert.isFalse(harness.isAttached());
      assert.equal(harness.commands.filter((command) => command === "detach").length, 1);

      yield* advance(MIN_CAPTURE_INTERVAL_MS);
      yield* advance(CAPTURE_DURATION_MS);
      assert.equal(harness.commands.filter((command) => command === "attach").length, 2);
      assert.equal(
        [...harness.writes.keys()].filter((path) => path.endsWith(".cpuprofile")).length,
        1,
      );
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("writes only allowlisted metadata and uses only the Profiler domain", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const fiber = yield* makeRendererStallWatchdog(harness.dependencies)
        .watch(harness.target)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* advance(STALL_THRESHOLD_MS + CHECK_INTERVAL_MS + CAPTURE_DURATION_MS);

      const metadataEntry = [...harness.writes.entries()].find(([path]) => path.endsWith(".json"));
      assert.isDefined(metadataEntry);
      const metadata = decodeJson(metadataEntry[1]) as Record<string, unknown>;
      assert.deepEqual(Object.keys(metadata).sort(), [
        "appVersion",
        "arch",
        "captureDurationMs",
        "capturedAt",
        "heartbeatIntervalMs",
        "missedHeartbeatCount",
        "platform",
        "processUptimeSeconds",
        "sessionCaptureIndex",
        "stallDurationMs",
      ]);
      assert.notMatch(encodeJson(metadata), /https?:\/\/|token/i);
      assert.deepEqual(
        harness.commands.filter((command) => command.includes(".")),
        ["Profiler.enable", "Profiler.start", "Profiler.stop", "Profiler.disable"],
      );
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
