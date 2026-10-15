import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  CAPTURE_DURATION_MS,
  CHECK_INTERVAL_MS,
  MAX_RETAINED_PROFILES,
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
      readDirectory: (path) =>
        Effect.sync(() => [...writes.keys()].map((entry) => entry.slice(path.length + 1))),
      remove: (path) =>
        Effect.sync(() => {
          writes.delete(path);
        }),
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

  it.effect("captures a bounded CPU profile on demand without a stall", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const watchdog = makeRendererStallWatchdog(harness.dependencies);
      const capture = yield* watchdog.captureNow(harness.target).pipe(Effect.forkChild);

      yield* advance(CAPTURE_DURATION_MS);
      assert.isTrue(yield* Fiber.join(capture));
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

  it.effect("rate-limits a persistent stall and retains the newest five captures", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const fiber = yield* makeRendererStallWatchdog(harness.dependencies)
        .watch(harness.target)
        .pipe(Effect.forkChild({ startImmediately: true }));

      for (let index = 0; index < MAX_RETAINED_PROFILES + 2; index += 1) {
        yield* advance(
          index === 0 ? STALL_THRESHOLD_MS + CHECK_INTERVAL_MS : MIN_CAPTURE_INTERVAL_MS,
        );
        yield* advance(CAPTURE_DURATION_MS);
      }

      assert.equal(
        harness.commands.filter((command) => command === "attach").length,
        MAX_RETAINED_PROFILES + 2,
      );
      const metadata = [...harness.writes.entries()]
        .filter(([path]) => path.endsWith(".json"))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, contents]) => decodeJson(contents) as { sessionCaptureIndex: number });
      assert.deepStrictEqual(
        metadata.map((entry) => entry.sessionCaptureIndex),
        [3, 4, 5, 6, 7],
      );
      assert.equal(harness.writes.size, MAX_RETAINED_PROFILES * 2);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("prunes captures from previous sessions and preserves unrelated files", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-renderer-profiles-test-" });
      const oldBasenames = Array.from(
        { length: 6 },
        (_, index) => `renderer-stall-1969-12-${20 + index}T00-00-00.000Z`,
      );
      for (const basename of oldBasenames) {
        yield* fs.writeFileString(`${dir}/${basename}.cpuprofile`, "{}");
        yield* fs.writeFileString(`${dir}/${basename}.json`, "{}");
      }
      yield* fs.writeFileString(`${dir}/unrelated.cpuprofile`, "keep");
      yield* fs.writeFileString(`${dir}/renderer-stall-not-a-timestamp.json`, "keep");
      const watchdog = makeRendererStallWatchdog({
        ...harness.dependencies,
        diagnosticsDir: dir,
        fileSystem: {
          makeDirectory: (path) => fs.makeDirectory(path, { recursive: true }).pipe(Effect.orDie),
          readDirectory: (path) => fs.readDirectory(path).pipe(Effect.orDie),
          writeFileString: (path, contents) =>
            fs.writeFileString(path, contents).pipe(Effect.orDie),
          remove: (path) => fs.remove(path, { force: true }).pipe(Effect.orDie),
        },
      });
      const capture = yield* watchdog.captureNow(harness.target).pipe(Effect.forkChild);
      yield* advance(CAPTURE_DURATION_MS);
      assert.isTrue(yield* Fiber.join(capture));
      for (const [index, basename] of oldBasenames.entries()) {
        assert.equal(yield* fs.exists(`${dir}/${basename}.cpuprofile`), index >= 2);
        assert.equal(yield* fs.exists(`${dir}/${basename}.json`), index >= 2);
      }
      assert.equal(yield* fs.readFileString(`${dir}/unrelated.cpuprofile`), "keep");
      assert.equal(yield* fs.readFileString(`${dir}/renderer-stall-not-a-timestamp.json`), "keep");
      assert.equal((yield* fs.readDirectory(dir)).length, MAX_RETAINED_PROFILES * 2 + 2);
      assert.isFalse(yield* watchdog.captureNow(harness.target));
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, TestClock.layer()])),
  );

  it.effect("preserves previous captures when a replacement capture fails", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ failFirstStop: true });
      const profilePath = `${harness.dependencies.diagnosticsDir}/renderer-stall-1969-12-20T00-00-00.000Z.cpuprofile`;
      harness.writes.set(profilePath, "previous capture");
      const watchdog = makeRendererStallWatchdog(harness.dependencies);
      const capture = yield* watchdog
        .captureNow(harness.target)
        .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
      assert.isFalse(yield* watchdog.captureNow(harness.target));
      yield* advance(CAPTURE_DURATION_MS);
      assert.equal((yield* Fiber.join(capture))._tag, "Failure");
      assert.deepStrictEqual([...harness.writes.entries()], [[profilePath, "previous capture"]]);
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
