import { assert, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const { spawnSync } = NodeChildProcess;
const {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} = NodeFS;
const { platform, tmpdir } = NodeOS;
const { dirname, join, resolve } = NodePath;

function writeFixture(path, contents = "") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function electronExecutablePath(release) {
  const dist = join(release, "apps", "desktop", "node_modules", "electron", "dist");
  if (platform() === "darwin") {
    return join(dist, "Electron.app", "Contents", "MacOS", "Electron");
  }
  return join(dist, platform() === "win32" ? "electron.exe" : "electron");
}

function createCompleteRelease(release, sha) {
  writeFixture(join(release, "manifest.json"), `${JSON.stringify({ sha })}\n`);
  writeFixture(join(release, "package.json"), "{}\n");
  writeFixture(join(release, "apps", "desktop", "scripts", "start-electron.mjs"));
  writeFixture(join(release, "apps", "desktop", "node_modules", "electron", "package.json"));
  writeFixture(join(release, "apps", "desktop", "dist-electron", "main.cjs"));
  writeFixture(join(release, "apps", "server", "dist", "bin.mjs"));
  writeFixture(join(release, "assets", "dev", "blueprint-macos-1024.png"));
  writeFixture(join(release, "assets", "prod", "black-macos-1024.png"));
  const electronExecutable = electronExecutablePath(release);
  writeFixture(electronExecutable);
  if (platform() !== "win32") chmodSync(electronExecutable, 0o755);
}

function createProcessControl(
  processes,
  {
    now = Date.parse("2026-08-14T12:00:00.000Z"),
    onPause = () => undefined,
    httpReady = () => true,
  } = {},
) {
  const signals = [];
  let currentTime = now;
  return {
    signals,
    now: () => currentTime,
    pause: (milliseconds) => {
      currentTime += milliseconds;
      onPause(milliseconds);
    },
    isAlive: (pid) => processes.get(pid)?.alive === true,
    inspectProcess: (pid) => {
      const selected = processes.get(pid);
      if (!selected?.alive) throw new Error(`Could not inspect managed process ${String(pid)}.`);
      return { pid, ...selected };
    },
    listenerPids: (port) =>
      [...processes.entries()]
        .filter(([, selected]) => selected.alive && selected.listenerPort === port)
        .map(([pid]) => pid),
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      const selected = processes.get(pid);
      if (!selected?.alive) throw new Error(`Process ${String(pid)} is not alive.`);
      selected.onSignal?.(signal, selected);
    },
    httpReady,
  };
}

function createQuiescentProcessControl() {
  return createProcessControl(new Map());
}

it("launches the long-lived Electron runtime directly and records its pid", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-launch-owner-"));
  const release = join(sandbox, "release");
  const runtimeRoot = join(sandbox, "runtime");
  const sha = "a".repeat(40);

  try {
    createCompleteRelease(release, sha);
    const { launchRelease } = await import("./local-pipeline.mjs?launch-owner-test");
    const launches = [];
    launchRelease(
      "production",
      {
        base: runtimeRoot,
        home: join(runtimeRoot, "home"),
        pid: join(runtimeRoot, "electron.pid"),
        log: join(runtimeRoot, "electron.log"),
        port: 17774,
      },
      release,
      sha,
      {
        spawnProcess: (command, args, options) => {
          launches.push({ command, args, options });
          return { pid: 4242, unref() {} };
        },
        readBirthToken: () => "2026-08-14T11:59:00.000Z",
      },
    );

    assert.equal(launches.length, 1);
    assert.equal(launches[0].command, electronExecutablePath(release));
    assert.deepStrictEqual(launches[0].args, [
      join(release, "apps/desktop/dist-electron/main.cjs"),
    ]);
    assert.equal(launches[0].options.cwd, release);
    assert.equal(launches[0].options.detached, true);
    assert.equal(launches[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.deepStrictEqual(JSON.parse(readFileSync(join(runtimeRoot, "electron.pid"), "utf8")), {
      version: 1,
      pid: 4242,
      processBirthToken: "2026-08-14T11:59:00.000Z",
    });

    rmSync(join(runtimeRoot, "electron.pid"), { force: true });
    const terminationSignals = [];
    expect(() =>
      launchRelease(
        "production",
        {
          base: runtimeRoot,
          home: join(runtimeRoot, "home"),
          pid: join(runtimeRoot, "electron.pid"),
          log: join(runtimeRoot, "electron.log"),
          port: 17774,
        },
        release,
        sha,
        {
          spawnProcess: () => ({ pid: 4343, unref() {} }),
          terminateSpawnedRuntime: (child) => terminationSignals.push([child.pid, "SIGTERM"]),
          readBirthToken: () => {
            throw new Error("simulated birth-token inspection failure");
          },
        },
      ),
    ).toThrow("simulated birth-token inspection failure");
    assert.deepStrictEqual(terminationSignals, [[4343, "SIGTERM"]]);
    assert.equal(existsSync(join(runtimeRoot, "electron.pid")), false);

    expect(() =>
      launchRelease(
        "production",
        {
          base: runtimeRoot,
          home: join(runtimeRoot, "home"),
          pid: join(runtimeRoot, "electron.pid"),
          log: join(runtimeRoot, "electron.log"),
          port: 17774,
        },
        release,
        sha,
        {
          spawnProcess: () => ({ pid: 4444, unref() {} }),
          readBirthToken: () => "2026-08-14T11:59:00.000Z",
          writeLauncherRecord: () => {
            throw new Error("simulated launcher-record persistence failure");
          },
          terminateSpawnedRuntime: (child) => terminationSignals.push([child.pid, "SIGTERM"]),
        },
      ),
    ).toThrow("simulated launcher-record persistence failure");
    assert.deepStrictEqual(terminationSignals, [
      [4343, "SIGTERM"],
      [4444, "SIGTERM"],
    ]);

    let incompleteCleanupError;
    try {
      launchRelease(
        "production",
        {
          base: runtimeRoot,
          home: join(runtimeRoot, "home"),
          pid: join(runtimeRoot, "electron.pid"),
          log: join(runtimeRoot, "electron.log"),
          port: 17774,
        },
        release,
        sha,
        {
          spawnProcess: () => ({ pid: 4545, unref() {} }),
          readBirthToken: () => {
            throw new Error("simulated registration failure");
          },
          terminateSpawnedRuntime: () => {
            throw new Error("simulated spawned runtime survivor");
          },
        },
      );
    } catch (error) {
      incompleteCleanupError = error;
    }
    assert.equal(incompleteCleanupError instanceof AggregateError, true);
    assert.equal(incompleteCleanupError?.runtimeCleanupIncomplete, true);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("does not overwrite an existing legacy launcher marker", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-launch-legacy-owner-"));
  const release = join(sandbox, "release");
  const runtimeRoot = join(sandbox, "runtime");
  const launcherPath = join(runtimeRoot, "electron.pid");
  const legacyMarker = "5151\n";
  const sha = "a".repeat(40);

  try {
    createCompleteRelease(release, sha);
    writeFixture(launcherPath, legacyMarker);
    const { launchRelease } = await import("./local-pipeline.mjs?launch-legacy-owner-test");
    const launches = [];
    const cleanups = [];

    expect(() =>
      launchRelease(
        "production",
        {
          base: runtimeRoot,
          home: join(runtimeRoot, "home"),
          pid: launcherPath,
          log: join(runtimeRoot, "electron.log"),
          port: 17774,
        },
        release,
        sha,
        {
          spawnProcess: () => {
            launches.push(5252);
            return { pid: 5252, unref() {} };
          },
          terminateSpawnedRuntime: (child) => cleanups.push(child.pid),
        },
      ),
    ).toThrow(/ownership marker/);

    assert.deepStrictEqual(launches, []);
    assert.deepStrictEqual(cleanups, []);
    assert.equal(readFileSync(launcherPath, "utf8"), legacyMarker);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("preserves a launcher marker created while a new runtime is spawning", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-launch-owner-race-"));
  const release = join(sandbox, "release");
  const runtimeRoot = join(sandbox, "runtime");
  const launcherPath = join(runtimeRoot, "electron.pid");
  const competingMarker = "5353\n";
  const sha = "a".repeat(40);

  try {
    createCompleteRelease(release, sha);
    const { launchRelease } = await import("./local-pipeline.mjs?launch-owner-race-test");
    const cleanups = [];
    let unrefCalled = false;

    expect(() =>
      launchRelease(
        "production",
        {
          base: runtimeRoot,
          home: join(runtimeRoot, "home"),
          pid: launcherPath,
          log: join(runtimeRoot, "electron.log"),
          port: 17774,
        },
        release,
        sha,
        {
          spawnProcess: () => {
            writeFixture(launcherPath, competingMarker);
            return {
              pid: 5454,
              unref: () => {
                unrefCalled = true;
              },
            };
          },
          readBirthToken: () => "2026-08-14T11:59:00.000Z",
          terminateSpawnedRuntime: (child) => cleanups.push(child.pid),
        },
      ),
    ).toThrow();

    assert.equal(readFileSync(launcherPath, "utf8"), competingMarker);
    assert.deepStrictEqual(cleanups, [5454]);
    assert.equal(unrefCalled, false);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("fails closed when listener inspection reports an error", async () => {
  const { parseListenerPids } = await import("./local-pipeline.mjs?listener-inspection-test");

  expect(() =>
    parseListenerPids({ status: 1, stdout: "", stderr: "permission denied\n" }, 17774),
  ).toThrow("Could not inspect listeners on port 17774");
  assert.deepStrictEqual(parseListenerPids({ status: 1, stdout: "", stderr: "" }, 17774), []);
});

it("publishes complete releases atomically and reuses an existing SHA", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-atomic-build-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const sha = "a".repeat(40);
  const release = join(runtimeRoot, "production", "releases", sha);
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    const { build } = await import("./local-pipeline.mjs?atomic-build-test");
    const pendingReleases = [];
    const assembleRelease = (pendingRelease) => {
      pendingReleases.push(pendingRelease);
      assert.equal(existsSync(release), false, "an incomplete release must not be visible");
      createCompleteRelease(pendingRelease, sha);
    };

    await build("production", { assembleRelease, resolveCommit: () => sha });

    assert.equal(existsSync(release), true);
    assert.equal(existsSync(pendingReleases[0]), false);
    assert.deepStrictEqual(JSON.parse(readFileSync(join(release, "manifest.json"), "utf8")), {
      sha,
    });
    assert.deepStrictEqual(JSON.parse(readFileSync(join(artifactRoot, "manifest.json"), "utf8")), {
      sha,
    });

    await build("production", {
      assembleRelease: () => {
        throw new Error("a completed SHA must not be rebuilt");
      },
      resolveCommit: () => sha,
    });
    assert.equal(pendingReleases.length, 1);
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("cleans failed builds and rejects incomplete releases before deployment", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-incomplete-build-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const sha = "b".repeat(40);
  const release = join(runtimeRoot, "production", "releases", sha);
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    const { build, deploy } = await import("./local-pipeline.mjs?failed-build-test");
    let pendingRelease;

    await expect(
      build("production", {
        assembleRelease: (pending) => {
          pendingRelease = pending;
          writeFixture(join(pending, "partial"));
          throw new Error("simulated packaging failure");
        },
        resolveCommit: () => sha,
      }),
    ).rejects.toThrow("simulated packaging failure");

    assert.equal(existsSync(pendingRelease), false);
    assert.equal(existsSync(release), false);
    assert.equal(existsSync(join(artifactRoot, "manifest.json")), false);

    writeFixture(join(release, "manifest.json"), `${JSON.stringify({ sha })}\n`);
    writeFixture(join(artifactRoot, "manifest.json"), `${JSON.stringify({ sha })}\n`);
    const launches = [];
    await expect(
      deploy("production", {
        processControl: createQuiescentProcessControl(),
        resolveTrackedHead: () => sha,
        launch: (...args) => launches.push(args),
        waitUntilReady: () => undefined,
      }),
    ).rejects.toThrow("is incomplete; run the build stage first");
    assert.deepStrictEqual(launches, []);
    assert.equal(existsSync(join(runtimeRoot, "production", "current")), false);
    assert.equal(existsSync(join(release, "partial")), false);
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("restores the complete release snapshot when the replacement cannot launch", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-deploy-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const shaC = "c".repeat(40);
  const releaseA = join(productionRoot, "releases", shaA);
  const releaseB = join(productionRoot, "releases", shaB);
  const releaseC = join(productionRoot, "releases", shaC);
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(releaseA, shaA);
    createCompleteRelease(releaseB, shaB);
    createCompleteRelease(releaseC, shaC);
    writeFixture(join(artifactRoot, "manifest.json"), `${JSON.stringify({ sha: shaC })}\n`);
    symlinkSync(releaseA, join(productionRoot, "current"));
    symlinkSync(releaseB, join(productionRoot, "previous"));

    const { deploy } = await import("./local-pipeline.mjs");
    const launches = [];
    const selectedReleaseA = realpathSync(releaseA);
    const selectedReleaseB = realpathSync(releaseB);
    await expect(
      deploy("production", {
        processControl: createQuiescentProcessControl(),
        resolveTrackedHead: () => shaC,
        verify: () => undefined,
        launch: (_name, _paths, release) => {
          launches.push(release);
          if (release === releaseC) throw new Error("simulated launch failure");
        },
        waitUntilReady: () => undefined,
      }),
    ).rejects.toThrow("simulated launch failure");

    assert.deepStrictEqual(launches, [releaseC, selectedReleaseA]);
    assert.deepStrictEqual(
      {
        current: realpathSync(join(productionRoot, "current")),
        previous: realpathSync(join(productionRoot, "previous")),
      },
      { current: selectedReleaseA, previous: selectedReleaseB },
    );
    assert.equal(readlinkSync(join(productionRoot, "current")), selectedReleaseA);
    assert.equal(readlinkSync(join(productionRoot, "previous")), selectedReleaseB);

    launches.length = 0;
    const incompleteCleanup = new Error("spawned runtime cleanup incomplete");
    incompleteCleanup.runtimeCleanupIncomplete = true;
    let withheldRecoveryError;
    try {
      await deploy("production", {
        processControl: createQuiescentProcessControl(),
        resolveTrackedHead: () => shaC,
        verify: () => undefined,
        launch: (_name, _paths, release) => {
          launches.push(release);
          throw incompleteCleanup;
        },
        waitUntilReady: () => undefined,
      });
    } catch (error) {
      withheldRecoveryError = error;
    }
    assert.equal(withheldRecoveryError instanceof AggregateError, true);
    assert.deepStrictEqual(
      launches,
      [releaseC],
      "recovery must not launch while cleanup is unsafe",
    );
    assert.equal(realpathSync(join(productionRoot, "current")), realpathSync(releaseC));
    assert.equal(existsSync(join(productionRoot, "operation-transaction.json")), true);
    assert.equal(existsSync(join(productionRoot, "manual-intervention-required.json")), true);
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("rejects a stale production artifact before launch or pointer mutation", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-stale-deploy-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const currentSha = "a".repeat(40);
  const previousSha = "b".repeat(40);
  const artifactSha = "c".repeat(40);
  const remoteHeadSha = "d".repeat(40);
  const currentRelease = join(productionRoot, "releases", currentSha);
  const previousRelease = join(productionRoot, "releases", previousSha);
  const artifactRelease = join(productionRoot, "releases", artifactSha);
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(currentRelease, currentSha);
    createCompleteRelease(previousRelease, previousSha);
    createCompleteRelease(artifactRelease, artifactSha);
    writeFixture(join(artifactRoot, "manifest.json"), `${JSON.stringify({ sha: artifactSha })}\n`);
    symlinkSync(currentRelease, join(productionRoot, "current"));
    symlinkSync(previousRelease, join(productionRoot, "previous"));

    const { deploy } = await import("./local-pipeline.mjs?stale-head-test");
    const launches = [];
    let deployError;
    try {
      await deploy("production", {
        processControl: createQuiescentProcessControl(),
        resolveTrackedHead: () => remoteHeadSha,
        launch: (_name, _paths, release) => launches.push(release),
        waitUntilReady: () => undefined,
      });
    } catch (error) {
      deployError = error;
    }

    assert.deepStrictEqual(
      {
        launches,
        current: realpathSync(join(productionRoot, "current")),
        previous: realpathSync(join(productionRoot, "previous")),
      },
      {
        launches: [],
        current: realpathSync(currentRelease),
        previous: realpathSync(previousRelease),
      },
      "a stale production artifact must be rejected before launch or pointer mutation",
    );
    assert.ok(deployError instanceof Error, "a stale production artifact must reject deploy");
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("rejects a stale same-SHA artifact before rebuilding an incomplete current release", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-stale-incomplete-deploy-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const artifactSha = "c".repeat(40);
  const remoteHeadSha = "d".repeat(40);
  const artifactRelease = join(productionRoot, "releases", artifactSha);
  const launcherPid = join(productionRoot, "electron.pid");
  const pnpmSentinel = join(sandbox, "pnpm-invoked");
  const fakeBin = join(sandbox, "bin");
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;
  const previousPath = process.env.PATH;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
    createCompleteRelease(artifactRelease, artifactSha);
    rmSync(electronExecutablePath(artifactRelease));
    writeFixture(join(artifactRoot, "manifest.json"), `${JSON.stringify({ sha: artifactSha })}\n`);
    symlinkSync(artifactRelease, join(productionRoot, "current"));
    writeFixture(launcherPid, "2147483647\n");
    const fakePnpm = join(fakeBin, "pnpm");
    writeFixture(fakePnpm, `#!/bin/sh\nprintf invoked > '${pnpmSentinel}'\nexit 99\n`);
    chmodSync(fakePnpm, 0o755);

    const { deploy } = await import("./local-pipeline.mjs?stale-incomplete-head-test");
    let deployError;
    try {
      await deploy("production", {
        processControl: createQuiescentProcessControl(),
        resolveTrackedHead: () => remoteHeadSha,
        launch: () => undefined,
        waitUntilReady: () => undefined,
      });
    } catch (error) {
      deployError = error;
    }

    assert.deepStrictEqual(
      {
        current: readlinkSync(join(productionRoot, "current")),
        launcherPidExists: existsSync(launcherPid),
        pnpmInvoked: existsSync(pnpmSentinel),
        error: deployError?.message,
      },
      {
        current: artifactRelease,
        launcherPidExists: true,
        pnpmInvoked: false,
        error: `Refusing to deploy production artifact ${artifactSha}; fork main is ${remoteHeadSha}.`,
      },
      "fork-main freshness must be established before touching an incomplete current release",
    );
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("rejects a production artifact when fork main advances between preflight and cutover", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-head-advanced-deploy-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const currentSha = "a".repeat(40);
  const previousSha = "b".repeat(40);
  const artifactSha = "c".repeat(40);
  const advancedSha = "d".repeat(40);
  const currentRelease = join(productionRoot, "releases", currentSha);
  const previousRelease = join(productionRoot, "releases", previousSha);
  const artifactRelease = join(productionRoot, "releases", artifactSha);
  const operationTransaction = join(productionRoot, "operation-transaction.json");
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(currentRelease, currentSha);
    createCompleteRelease(previousRelease, previousSha);
    createCompleteRelease(artifactRelease, artifactSha);
    writeFixture(join(artifactRoot, "manifest.json"), `${JSON.stringify({ sha: artifactSha })}\n`);
    symlinkSync(currentRelease, join(productionRoot, "current"));
    symlinkSync(previousRelease, join(productionRoot, "previous"));

    const { deploy } = await import("./local-pipeline.mjs?head-advanced-before-cutover-test");
    const resolvedHeads = [artifactSha, advancedSha];
    let deployError;
    try {
      await deploy("production", {
        processControl: createQuiescentProcessControl(),
        resolveTrackedHead: () => resolvedHeads.shift(),
        launch: () => undefined,
        waitUntilReady: () => undefined,
      });
    } catch (error) {
      deployError = error;
    }

    assert.deepStrictEqual(
      {
        remainingHeads: resolvedHeads,
        current: realpathSync(join(productionRoot, "current")),
        previous: realpathSync(join(productionRoot, "previous")),
        operationTransactionExists: existsSync(operationTransaction),
        error: deployError?.message,
      },
      {
        remainingHeads: [],
        current: realpathSync(currentRelease),
        previous: realpathSync(previousRelease),
        operationTransactionExists: false,
        error: `Refusing to deploy production artifact ${artifactSha}; fork main is ${advancedSha}.`,
      },
      "the final head check must happen before journaling, stopping, or changing pointers",
    );
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("rejects a production deploy while another operation holds the lock", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-locked-deploy-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const currentSha = "a".repeat(40);
  const previousSha = "b".repeat(40);
  const artifactSha = "c".repeat(40);
  const currentRelease = join(productionRoot, "releases", currentSha);
  const previousRelease = join(productionRoot, "releases", previousSha);
  const artifactRelease = join(productionRoot, "releases", artifactSha);
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(currentRelease, currentSha);
    createCompleteRelease(previousRelease, previousSha);
    createCompleteRelease(artifactRelease, artifactSha);
    writeFixture(join(artifactRoot, "manifest.json"), `${JSON.stringify({ sha: artifactSha })}\n`);
    symlinkSync(currentRelease, join(productionRoot, "current"));
    symlinkSync(previousRelease, join(productionRoot, "previous"));
    writeFixture(
      join(productionRoot, "operation.lock"),
      `${JSON.stringify({ pid: process.pid, token: "active-test-owner" })}\n`,
    );

    const { deploy } = await import("./local-pipeline.mjs?operation-lock-test");
    const launches = [];
    let deployError;
    try {
      await deploy("production", {
        processControl: createQuiescentProcessControl(),
        resolveTrackedHead: () => artifactSha,
        launch: (_name, _paths, release) => launches.push(release),
        waitUntilReady: () => undefined,
      });
    } catch (error) {
      deployError = error;
    }

    assert.deepStrictEqual(
      {
        launches,
        current: realpathSync(join(productionRoot, "current")),
        previous: realpathSync(join(productionRoot, "previous")),
      },
      {
        launches: [],
        current: realpathSync(currentRelease),
        previous: realpathSync(previousRelease),
      },
      "a held production operation lock must reject before launch or pointer mutation",
    );
    assert.match(
      deployError?.message ?? "",
      /lock/i,
      "a conflicting production operation must reject with a lock error",
    );
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("refuses to signal a foreign process occupying the production port", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-unowned-launcher-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const launcherPid = join(productionRoot, "electron.pid");
  const operationLock = join(productionRoot, "operation.lock");
  const release = join(productionRoot, "releases", "a".repeat(40));
  const unrelatedPid = 4101;
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(release, "a".repeat(40));
    symlinkSync(release, join(productionRoot, "current"));
    writeFixture(
      launcherPid,
      `${JSON.stringify({
        version: 1,
        pid: unrelatedPid,
        processBirthToken: "2026-08-14T11:00:00.000Z",
      })}\n`,
    );
    const processes = new Map([
      [
        unrelatedPid,
        {
          alive: true,
          birthToken: "2026-08-14T11:00:00.000Z",
          command: "/usr/bin/unrelated --serve",
          cwd: realpathSync(release),
          listenerPort: 17774,
        },
      ],
    ]);
    const processControl = createProcessControl(processes);

    const { stop } = await import("./local-pipeline.mjs?unowned-launcher-stop-test");
    await expect(stop("production", { processControl })).rejects.toThrow(
      /occupied by an unverified process/,
    );

    assert.deepStrictEqual(processControl.signals, []);
    assert.equal(
      existsSync(launcherPid),
      true,
      "the rejected pid record must remain for diagnosis",
    );
    assert.equal(existsSync(operationLock), false, "the operation lock must still be released");
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("stops an owned orphan backend after the tracked launcher exited", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-orphaned-backend-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const sha = "a".repeat(40);
  const release = join(productionRoot, "releases", sha);
  const backendPid = 4202;
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(release, sha);
    symlinkSync(release, join(productionRoot, "current"));
    writeFixture(join(productionRoot, "electron.pid"), "2147483647\n");
    writeFixture(
      join(productionRoot, "home", "userdata", "server-runtime.json"),
      `${JSON.stringify({
        version: 1,
        pid: backendPid,
        port: 17774,
        origin: "http://127.0.0.1:17774",
        startedAt: "2026-08-14T11:59:00.000Z",
      })}\n`,
    );
    const selectedRelease = realpathSync(release);
    const processes = new Map([
      [
        backendPid,
        {
          alive: true,
          ppid: 1,
          birthToken: "2026-08-14T11:58:59.000Z",
          command: `${electronExecutablePath(selectedRelease)} ${join(selectedRelease, "apps/server/dist/bin.mjs")} --bootstrap-fd 3`,
          cwd: selectedRelease,
          listenerPort: 17774,
          onSignal: (signal, selected) => {
            if (signal === "SIGTERM") {
              selected.alive = false;
              selected.listenerPort = undefined;
            }
          },
        },
      ],
    ]);
    const processControl = createProcessControl(processes);

    const { stop } = await import("./local-pipeline.mjs?orphaned-backend-test");
    await stop("production", { processControl });

    assert.deepStrictEqual(processControl.signals, [[backendPid, "SIGTERM"]]);
    assert.equal(processControl.listenerPids(17774).length, 0);
    assert.equal(existsSync(join(productionRoot, "electron.pid")), false);
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// macOS runs the desktop app from a branded bundle whose Electron binary is a
// copy of the packaged one, so these cases only exist there.
const itMac = platform() === "darwin" ? it : it.skip;

function brandedElectronExecutablePath(release, product = "T3 Code (Alpha)") {
  return join(
    release,
    "apps",
    "desktop",
    ".electron-runtime",
    `${product}.app`,
    "Contents",
    "MacOS",
    "Electron",
  );
}

itMac("stops a backend launched from the release's branded runtime bundle", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-branded-backend-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const sha = "a".repeat(40);
  const release = join(productionRoot, "releases", sha);
  const backendPid = 4242;
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(release, sha);
    // The branded bundle is a separate copy, never a symlink to node_modules.
    const brandedExecutable = brandedElectronExecutablePath(release);
    writeFixture(brandedExecutable);
    chmodSync(brandedExecutable, 0o755);
    symlinkSync(release, join(productionRoot, "current"));
    writeFixture(join(productionRoot, "electron.pid"), "2147483647\n");
    writeFixture(
      join(productionRoot, "home", "userdata", "server-runtime.json"),
      `${JSON.stringify({
        version: 1,
        pid: backendPid,
        port: 17774,
        origin: "http://127.0.0.1:17774",
        startedAt: "2026-08-14T11:59:00.000Z",
      })}\n`,
    );
    const selectedRelease = realpathSync(release);
    const processes = new Map([
      [
        backendPid,
        {
          alive: true,
          ppid: 1,
          birthToken: "2026-08-14T11:58:59.000Z",
          command: `${brandedElectronExecutablePath(selectedRelease)} ${join(selectedRelease, "apps/server/dist/bin.mjs")} --bootstrap-fd 3`,
          cwd: selectedRelease,
          listenerPort: 17774,
          onSignal: (signal, selected) => {
            if (signal === "SIGTERM") {
              selected.alive = false;
              selected.listenerPort = undefined;
            }
          },
        },
      ],
    ]);
    const processControl = createProcessControl(processes);

    const { stop } = await import("./local-pipeline.mjs?branded-backend-test");
    await stop("production", { processControl });

    assert.deepStrictEqual(processControl.signals, [[backendPid, "SIGTERM"]]);
    assert.equal(processControl.listenerPids(17774).length, 0);
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

itMac("refuses a backend running a branded bundle from outside the release", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-foreign-branded-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const sha = "a".repeat(40);
  const release = join(productionRoot, "releases", sha);
  // A different checkout's branded bundle: same shape, wrong root.
  const foreignRelease = join(sandbox, "elsewhere");
  const backendPid = 4243;
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(release, sha);
    const brandedExecutable = brandedElectronExecutablePath(release);
    writeFixture(brandedExecutable);
    chmodSync(brandedExecutable, 0o755);
    writeFixture(brandedElectronExecutablePath(foreignRelease));
    symlinkSync(release, join(productionRoot, "current"));
    writeFixture(join(productionRoot, "electron.pid"), "2147483647\n");
    writeFixture(
      join(productionRoot, "home", "userdata", "server-runtime.json"),
      `${JSON.stringify({
        version: 1,
        pid: backendPid,
        port: 17774,
        origin: "http://127.0.0.1:17774",
        startedAt: "2026-08-14T11:59:00.000Z",
      })}\n`,
    );
    const selectedRelease = realpathSync(release);
    const processes = new Map([
      [
        backendPid,
        {
          alive: true,
          ppid: 1,
          birthToken: "2026-08-14T11:58:59.000Z",
          command: `${brandedElectronExecutablePath(foreignRelease)} ${join(selectedRelease, "apps/server/dist/bin.mjs")} --bootstrap-fd 3`,
          cwd: selectedRelease,
          listenerPort: 17774,
        },
      ],
    ]);
    const processControl = createProcessControl(processes);

    const { stop } = await import("./local-pipeline.mjs?foreign-branded-test");
    await expect(stop("production", { processControl })).rejects.toThrow(
      /process identity does not match/,
    );
    assert.deepStrictEqual(processControl.signals, []);
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("quiesces a legacy launcher before deploying past its respawning backend", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-legacy-launcher-deploy-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const shaC = "c".repeat(40);
  const releaseA = join(productionRoot, "releases", shaA);
  const releaseB = join(productionRoot, "releases", shaB);
  const releaseC = join(productionRoot, "releases", shaC);
  const launcherPath = join(productionRoot, "electron.pid");
  const runtimeStatePath = join(productionRoot, "home/userdata/server-runtime.json");
  const launcherPid = 4251;
  const backendPid = 4252;
  const respawnedBackendPid = 4253;
  const legacyMarker = `${String(launcherPid)}\n`;
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    for (const [release, sha] of [
      [releaseA, shaA],
      [releaseB, shaB],
      [releaseC, shaC],
    ]) {
      createCompleteRelease(release, sha);
    }
    writeFixture(join(artifactRoot, "manifest.json"), `${JSON.stringify({ sha: shaC })}\n`);
    symlinkSync(releaseA, join(productionRoot, "current"));
    symlinkSync(releaseB, join(productionRoot, "previous"));
    writeFixture(launcherPath, legacyMarker);
    writeFixture(
      runtimeStatePath,
      `${JSON.stringify({
        version: 1,
        pid: backendPid,
        port: 17774,
        origin: "http://127.0.0.1:17774",
        startedAt: "2026-08-14T11:59:00.000Z",
      })}\n`,
    );
    const selectedReleaseA = realpathSync(releaseA);
    const launcherCommand = `${electronExecutablePath(selectedReleaseA)} ${join(selectedReleaseA, "apps/desktop/dist-electron/main.cjs")}`;
    const backendCommand = `${electronExecutablePath(selectedReleaseA)} ${join(selectedReleaseA, "apps/server/dist/bin.mjs")} --bootstrap-fd 3`;
    const markersAtLauncherSignals = [];
    let backendRespawns = 0;
    const processes = new Map();
    const stopBackend = (selected) => {
      selected.alive = false;
      selected.listenerPort = undefined;
    };
    processes.set(launcherPid, {
      alive: true,
      ppid: 1,
      birthToken: "2026-08-14T11:58:00.000Z",
      command: launcherCommand,
      cwd: selectedReleaseA,
      onSignal: (signal, selected) => {
        markersAtLauncherSignals.push(readFileSync(launcherPath, "utf8"));
        if (signal === "SIGTERM") {
          stopBackend(processes.get(backendPid));
        } else if (signal === "SIGKILL") {
          selected.alive = false;
        }
      },
    });
    processes.set(backendPid, {
      alive: true,
      ppid: launcherPid,
      birthToken: "2026-08-14T11:58:59.000Z",
      command: backendCommand,
      cwd: selectedReleaseA,
      listenerPort: 17774,
      onSignal: (signal, selected) => {
        if (signal !== "SIGTERM") return;
        stopBackend(selected);
        backendRespawns += 1;
        processes.set(respawnedBackendPid, {
          alive: true,
          ppid: launcherPid,
          birthToken: "2026-08-14T12:00:00.000Z",
          command: backendCommand,
          cwd: selectedReleaseA,
          listenerPort: 17774,
        });
        writeFixture(
          runtimeStatePath,
          `${JSON.stringify({
            version: 1,
            pid: respawnedBackendPid,
            port: 17774,
            origin: "http://127.0.0.1:17774",
            startedAt: "2026-08-14T12:00:00.000Z",
          })}\n`,
        );
      },
    });
    const processControl = createProcessControl(processes);
    const launches = [];
    const { deploy } = await import("./local-pipeline.mjs?legacy-launcher-respawn-deploy-test");

    await deploy("production", {
      processControl,
      resolveTrackedHead: () => shaC,
      launch: (_name, _paths, release) => {
        launches.push({
          release: realpathSync(release),
          launcherAlive: processes.get(launcherPid).alive,
          backendAlive: processes.get(backendPid).alive,
          listenerPids: processControl.listenerPids(17774),
        });
      },
      waitUntilReady: () => undefined,
      verify: () => undefined,
    });

    assert.deepStrictEqual(processControl.signals, [
      [launcherPid, "SIGTERM"],
      [launcherPid, "SIGKILL"],
    ]);
    assert.deepStrictEqual(
      markersAtLauncherSignals,
      [legacyMarker, legacyMarker],
      "shutdown must not rewrite the legacy marker before either signal",
    );
    assert.equal(backendRespawns, 0, "the backend-only shutdown path must never run");
    assert.deepStrictEqual(launches, [
      {
        release: realpathSync(releaseC),
        launcherAlive: false,
        backendAlive: false,
        listenerPids: [],
      },
    ]);
    assert.equal(realpathSync(join(productionRoot, "current")), realpathSync(releaseC));
    assert.equal(existsSync(launcherPath), false);
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("fails closed when a legacy launcher cannot be tied to its backend", async () => {
  const cases = [
    {
      name: "missing-backend",
      launcherCommand: "managed",
      backendAlive: false,
      backendParent: 5551,
      error: /without an authenticated backend/,
      loadPipeline: () => import("./local-pipeline.mjs?legacy-launcher-missing-backend-test"),
    },
    {
      name: "wrong-parent",
      launcherCommand: "managed",
      backendAlive: true,
      backendParent: 1,
      error: /does not supervise the authenticated backend/,
      loadPipeline: () => import("./local-pipeline.mjs?legacy-launcher-wrong-parent-test"),
    },
    {
      name: "foreign-launcher",
      launcherCommand: "foreign",
      backendAlive: true,
      backendParent: 5551,
      error: /process identity does not match/,
      loadPipeline: () => import("./local-pipeline.mjs?legacy-launcher-foreign-test"),
    },
    // The pre-versioned pipeline launched `node <release>/…/start-electron.mjs`.
    // Reaching the supervision check at all proves that shape authenticated;
    // before it was recognised this failed on the identity check instead.
    {
      name: "legacy-shape-authenticates",
      launcherCommand: "legacy-node",
      backendAlive: true,
      backendParent: 1,
      error: /does not supervise the authenticated backend/,
      loadPipeline: () => import("./local-pipeline.mjs?legacy-launcher-node-shape-test"),
    },
    // Same shape, script belonging to a different release: still refused, so
    // recognising it does not widen ownership beyond the selected release.
    {
      name: "legacy-shape-foreign-release",
      launcherCommand: "legacy-node-foreign",
      backendAlive: true,
      backendParent: 5551,
      error: /process identity does not match/,
      loadPipeline: () => import("./local-pipeline.mjs?legacy-launcher-node-foreign-test"),
    },
  ];

  for (const selectedCase of cases) {
    const sandbox = mkdtempSync(join(tmpdir(), `t3-gocd-legacy-${selectedCase.name}-`));
    const runtimeRoot = join(sandbox, "runtime");
    const artifactRoot = join(sandbox, "artifact");
    const productionRoot = join(runtimeRoot, "production");
    const shaA = "a".repeat(40);
    const shaC = "c".repeat(40);
    const releaseA = join(productionRoot, "releases", shaA);
    const releaseC = join(productionRoot, "releases", shaC);
    const launcherPath = join(productionRoot, "electron.pid");
    const launcherPid = 5551;
    const backendPid = 5552;
    const legacyMarker = `${String(launcherPid)}\n`;
    const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
    const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

    try {
      process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
      process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
      createCompleteRelease(releaseA, shaA);
      createCompleteRelease(releaseC, shaC);
      writeFixture(join(artifactRoot, "manifest.json"), `${JSON.stringify({ sha: shaC })}\n`);
      symlinkSync(releaseA, join(productionRoot, "current"));
      writeFixture(launcherPath, legacyMarker);
      writeFixture(
        join(productionRoot, "home/userdata/server-runtime.json"),
        `${JSON.stringify({
          version: 1,
          pid: backendPid,
          port: 17774,
          origin: "http://127.0.0.1:17774",
          startedAt: "2026-08-14T11:59:00.000Z",
        })}\n`,
      );
      const selectedReleaseA = realpathSync(releaseA);
      const managedLauncherCommand = `${electronExecutablePath(selectedReleaseA)} ${join(selectedReleaseA, "apps/desktop/dist-electron/main.cjs")}`;
      const processes = new Map([
        [
          launcherPid,
          {
            alive: true,
            ppid: 1,
            birthToken: "2026-08-14T11:58:00.000Z",
            command:
              {
                managed: managedLauncherCommand,
                "legacy-node": `/opt/homebrew/bin/node ${join(selectedReleaseA, "apps/desktop/scripts/start-electron.mjs")}`,
                "legacy-node-foreign": `/opt/homebrew/bin/node ${join(sandbox, "elsewhere", "apps/desktop/scripts/start-electron.mjs")}`,
              }[selectedCase.launcherCommand] ?? "/usr/bin/foreign --serve",
            cwd: selectedReleaseA,
          },
        ],
        [
          backendPid,
          {
            alive: selectedCase.backendAlive,
            ppid: selectedCase.backendParent,
            birthToken: "2026-08-14T11:58:59.000Z",
            command: `${electronExecutablePath(selectedReleaseA)} ${join(selectedReleaseA, "apps/server/dist/bin.mjs")} --bootstrap-fd 3`,
            cwd: selectedReleaseA,
            listenerPort: selectedCase.backendAlive ? 17774 : undefined,
          },
        ],
      ]);
      const processControl = createProcessControl(processes);
      const launches = [];
      const { deploy } = await selectedCase.loadPipeline();

      await expect(
        deploy("production", {
          processControl,
          resolveTrackedHead: () => shaC,
          launch: (...args) => launches.push(args),
          waitUntilReady: () => undefined,
          verify: () => undefined,
        }),
      ).rejects.toThrow(selectedCase.error);

      assert.deepStrictEqual(processControl.signals, []);
      assert.deepStrictEqual(launches, []);
      assert.equal(readFileSync(launcherPath, "utf8"), legacyMarker);
      assert.equal(realpathSync(join(productionRoot, "current")), selectedReleaseA);
    } finally {
      if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
      else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
      if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
      else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
      rmSync(sandbox, { recursive: true, force: true });
    }
  }
});

// Capture and the terminate-time re-validation must accept the same launcher
// shapes. While only capture knew the pre-versioned Node shape, a deploy could
// authenticate the launcher and then refuse to terminate it, stranding the
// environment mid-transaction and demanding manual intervention.
it("terminates a pre-versioned launcher it authenticated at capture", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-legacy-node-stop-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const sha = "a".repeat(40);
  const release = join(productionRoot, "releases", sha);
  const launcherPid = 5851;
  const backendPid = 5852;
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(release, sha);
    symlinkSync(release, join(productionRoot, "current"));
    writeFixture(join(productionRoot, "electron.pid"), `${String(launcherPid)}\n`);
    writeFixture(
      join(productionRoot, "home", "userdata", "server-runtime.json"),
      `${JSON.stringify({
        version: 1,
        pid: backendPid,
        port: 17774,
        origin: "http://127.0.0.1:17774",
        startedAt: "2026-08-14T11:59:00.000Z",
      })}\n`,
    );
    const selectedRelease = realpathSync(release);
    const die = (signal, selected) => {
      if (signal === "SIGTERM") {
        selected.alive = false;
        selected.listenerPort = undefined;
      }
    };
    const processes = new Map([
      [
        launcherPid,
        {
          alive: true,
          ppid: 1,
          birthToken: "2026-08-14T11:58:00.000Z",
          command: `/opt/homebrew/bin/node ${join(selectedRelease, "apps/desktop/scripts/start-electron.mjs")}`,
          cwd: selectedRelease,
          onSignal: die,
        },
      ],
      [
        backendPid,
        {
          alive: true,
          ppid: launcherPid,
          birthToken: "2026-08-14T11:58:59.000Z",
          command: `${electronExecutablePath(selectedRelease)} ${join(selectedRelease, "apps/server/dist/bin.mjs")} --bootstrap-fd 3`,
          cwd: selectedRelease,
          listenerPort: 17774,
          onSignal: die,
        },
      ],
    ]);
    const processControl = createProcessControl(processes);

    const { stop } = await import("./local-pipeline.mjs?legacy-node-stop-test");
    await stop("production", { processControl });

    assert.ok(
      processControl.signals.some(([pid, signal]) => pid === launcherPid && signal === "SIGTERM"),
      "the pre-versioned launcher must be terminated, not refused",
    );
    assert.equal(processControl.listenerPids(17774).length, 0);
    assert.equal(existsSync(join(productionRoot, "electron.pid")), false);
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("does not signal a legacy launcher after its marker changes", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-legacy-marker-race-"));
  const runtimeRoot = join(sandbox, "runtime");
  const productionRoot = join(runtimeRoot, "production");
  const sha = "a".repeat(40);
  const release = join(productionRoot, "releases", sha);
  const launcherPath = join(productionRoot, "electron.pid");
  const launcherPid = 5651;
  const backendPid = 5652;
  const replacementMarker = "5751\n";
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    createCompleteRelease(release, sha);
    symlinkSync(release, join(productionRoot, "current"));
    writeFixture(launcherPath, `${String(launcherPid)}\n`);
    writeFixture(
      join(productionRoot, "home/userdata/server-runtime.json"),
      `${JSON.stringify({
        version: 1,
        pid: backendPid,
        port: 17774,
        origin: "http://127.0.0.1:17774",
        startedAt: "2026-08-14T11:59:00.000Z",
      })}\n`,
    );
    const selectedRelease = realpathSync(release);
    const processes = new Map([
      [
        launcherPid,
        {
          alive: true,
          ppid: 1,
          birthToken: "2026-08-14T11:58:00.000Z",
          command: `${electronExecutablePath(selectedRelease)} ${join(selectedRelease, "apps/desktop/dist-electron/main.cjs")}`,
          cwd: selectedRelease,
        },
      ],
      [
        backendPid,
        {
          alive: true,
          ppid: launcherPid,
          birthToken: "2026-08-14T11:58:59.000Z",
          command: `${electronExecutablePath(selectedRelease)} ${join(selectedRelease, "apps/server/dist/bin.mjs")} --bootstrap-fd 3`,
          cwd: selectedRelease,
          listenerPort: 17774,
        },
      ],
    ]);
    const processControl = createProcessControl(processes);
    const inspectProcess = processControl.inspectProcess;
    let backendInspections = 0;
    processControl.inspectProcess = (pid) => {
      const identity = inspectProcess(pid);
      if (pid === backendPid && (backendInspections += 1) === 1) {
        writeFixture(launcherPath, replacementMarker);
      }
      return identity;
    };
    const { stop } = await import("./local-pipeline.mjs?legacy-launcher-marker-race-test");

    await expect(stop("production", { processControl })).rejects.toThrow(/reused legacy launcher/);

    assert.deepStrictEqual(processControl.signals, []);
    assert.equal(readFileSync(launcherPath, "utf8"), replacementMarker);
    assert.deepStrictEqual(processControl.listenerPids(17774), [backendPid]);
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("ignores a stale launcher record while stopping its independently owned backend", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-untracked-backend-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const runtimePidPath = join(productionRoot, "electron.pid");
  const sha = "a".repeat(40);
  const release = join(productionRoot, "releases", sha);
  const staleLauncherPid = 4301;
  const backendPid = 4302;
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(release, sha);
    symlinkSync(release, join(productionRoot, "current"));
    writeFixture(
      runtimePidPath,
      `${JSON.stringify({
        version: 1,
        pid: staleLauncherPid,
        processBirthToken: "2026-08-14T11:00:00.000Z",
      })}\n`,
    );
    writeFixture(
      join(productionRoot, "home", "userdata", "server-runtime.json"),
      `${JSON.stringify({
        version: 1,
        pid: backendPid,
        port: 17774,
        origin: "http://127.0.0.1:17774",
        startedAt: "2026-08-14T11:59:00.000Z",
      })}\n`,
    );
    const selectedRelease = realpathSync(release);
    const processes = new Map([
      [
        staleLauncherPid,
        {
          alive: true,
          ppid: 1,
          birthToken: "2026-08-14T11:30:00.000Z",
          command: `${electronExecutablePath(selectedRelease)} ${join(selectedRelease, "apps/desktop/dist-electron/main.cjs")}`,
          cwd: selectedRelease,
        },
      ],
      [
        backendPid,
        {
          alive: true,
          ppid: 1,
          birthToken: "2026-08-14T11:58:59.000Z",
          command: `${electronExecutablePath(selectedRelease)} ${join(selectedRelease, "apps/server/dist/bin.mjs")} --bootstrap-fd 3`,
          cwd: selectedRelease,
          listenerPort: 17774,
          onSignal: (signal, selected) => {
            if (signal === "SIGTERM") {
              selected.alive = false;
              selected.listenerPort = undefined;
            }
          },
        },
      ],
    ]);
    const processControl = createProcessControl(processes);
    const { stop } = await import("./local-pipeline.mjs?untracked-backend-test");

    await stop("production", { processControl });

    assert.deepStrictEqual(processControl.signals, [[backendPid, "SIGTERM"]]);
    assert.equal(processes.get(staleLauncherPid).alive, true);
    assert.equal(existsSync(runtimePidPath), true, "the stale live record remains diagnostic");
    assert.equal(processControl.listenerPids(17774).length, 0);
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("stops a relaunched Electron supervisor discovered through its managed backend", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-relaunched-supervisor-"));
  const runtimeRoot = join(sandbox, "runtime");
  const productionRoot = join(runtimeRoot, "production");
  const release = join(productionRoot, "releases", "a".repeat(40));
  const markerPath = join(productionRoot, "electron.pid");
  const staleLauncherPid = 4351;
  const supervisorPid = 4352;
  const backendPid = 4353;
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    createCompleteRelease(release, "a".repeat(40));
    symlinkSync(release, join(productionRoot, "current"));
    writeFixture(
      markerPath,
      `${JSON.stringify({
        version: 1,
        pid: staleLauncherPid,
        processBirthToken: "2026-08-14T11:00:00.000Z",
      })}\n`,
    );
    writeFixture(
      join(productionRoot, "home/userdata/server-runtime.json"),
      `${JSON.stringify({
        version: 1,
        pid: backendPid,
        port: 17774,
        origin: "http://127.0.0.1:17774",
        startedAt: "2026-08-14T12:00:00.000Z",
      })}\n`,
    );
    const selectedRelease = realpathSync(release);
    const processes = new Map();
    processes.set(supervisorPid, {
      alive: true,
      ppid: 1,
      birthToken: "2026-08-14T11:30:00.000Z",
      command: `${electronExecutablePath(selectedRelease)} ${join(selectedRelease, "apps/desktop/dist-electron/main.cjs")}`,
      cwd: selectedRelease,
      onSignal: (signal, selected) => {
        if (signal === "SIGTERM") {
          const backend = processes.get(backendPid);
          backend.alive = false;
          backend.listenerPort = undefined;
        } else if (signal === "SIGKILL") {
          selected.alive = false;
        }
      },
    });
    processes.set(backendPid, {
      alive: true,
      ppid: supervisorPid,
      birthToken: "2026-08-14T11:59:59.000Z",
      command: `${electronExecutablePath(selectedRelease)} ${join(selectedRelease, "apps/server/dist/bin.mjs")} --bootstrap-fd 3`,
      cwd: selectedRelease,
      listenerPort: 17774,
      onSignal: (_signal, selected) => {
        selected.alive = false;
        selected.listenerPort = undefined;
      },
    });
    const processControl = createProcessControl(processes);
    const { stop } = await import("./local-pipeline.mjs?relaunched-supervisor-test");

    await stop("production", { processControl });

    assert.deepStrictEqual(processControl.signals, [
      [supervisorPid, "SIGTERM"],
      [supervisorPid, "SIGKILL"],
    ]);
    assert.equal(processes.get(supervisorPid).alive, false);
    assert.equal(processes.get(backendPid).alive, false);
    assert.equal(processControl.listenerPids(17774).length, 0);
    assert.equal(existsSync(markerPath), false);
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("stops the Electron supervisor when a newer recorded launcher does not own the backend", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-shadow-launcher-"));
  const runtimeRoot = join(sandbox, "runtime");
  const productionRoot = join(runtimeRoot, "production");
  const release = join(productionRoot, "releases", "a".repeat(40));
  const markerPath = join(productionRoot, "electron.pid");
  const supervisorPid = 4361;
  const recordedLauncherPid = 4362;
  const backendPid = 4363;
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    createCompleteRelease(release, "a".repeat(40));
    symlinkSync(release, join(productionRoot, "current"));
    writeFixture(
      markerPath,
      `${JSON.stringify({
        version: 1,
        pid: recordedLauncherPid,
        processBirthToken: "2026-08-14T11:45:00.000Z",
      })}\n`,
    );
    writeFixture(
      join(productionRoot, "home/userdata/server-runtime.json"),
      `${JSON.stringify({
        version: 1,
        pid: backendPid,
        port: 17774,
        origin: "http://127.0.0.1:17774",
        startedAt: "2026-08-14T12:00:00.000Z",
      })}\n`,
    );
    const selectedRelease = realpathSync(release);
    const launcherCommand = `${electronExecutablePath(selectedRelease)} ${join(selectedRelease, "apps/desktop/dist-electron/main.cjs")}`;
    const relativeLauncherCommand = `${electronExecutablePath(selectedRelease)} dist-electron/main.cjs`;
    const processes = new Map([
      [
        supervisorPid,
        {
          alive: true,
          ppid: 1,
          birthToken: "2026-08-14T11:30:00.000Z",
          command: relativeLauncherCommand,
          cwd: join(selectedRelease, "apps/desktop"),
          onSignal: (_signal, selected) => {
            selected.alive = false;
            const backend = processes.get(backendPid);
            backend.alive = false;
            backend.listenerPort = undefined;
          },
        },
      ],
      [
        recordedLauncherPid,
        {
          alive: true,
          ppid: 1,
          birthToken: "2026-08-14T11:45:00.000Z",
          command: launcherCommand,
          cwd: selectedRelease,
        },
      ],
      [
        backendPid,
        {
          alive: true,
          ppid: supervisorPid,
          birthToken: "2026-08-14T11:59:59.000Z",
          command: `${electronExecutablePath(selectedRelease)} ${join(selectedRelease, "apps/server/dist/bin.mjs")} --bootstrap-fd 3`,
          cwd: selectedRelease,
          listenerPort: 17774,
        },
      ],
    ]);
    const processControl = createProcessControl(processes);
    const { stop } = await import("./local-pipeline.mjs?shadow-launcher-test");

    await stop("production", { processControl });

    assert.deepStrictEqual(processControl.signals, [[supervisorPid, "SIGTERM"]]);
    assert.equal(processes.get(supervisorPid).alive, false);
    assert.equal(processes.get(recordedLauncherPid).alive, true);
    assert.equal(processes.get(backendPid).alive, false);
    assert.equal(processControl.listenerPids(17774).length, 0);
    assert.equal(existsSync(markerPath), false);
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("stops an older Electron supervisor that reclaims the port during shutdown", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-runtime-handoff-"));
  const runtimeRoot = join(sandbox, "runtime");
  const productionRoot = join(runtimeRoot, "production");
  const release = join(productionRoot, "releases", "a".repeat(40));
  const markerPath = join(productionRoot, "electron.pid");
  const olderSupervisorPid = 4371;
  const recordedLauncherPid = 4372;
  const initialBackendPid = 4373;
  const replacementBackendPid = 4374;
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    createCompleteRelease(release, "a".repeat(40));
    symlinkSync(release, join(productionRoot, "current"));
    writeFixture(
      markerPath,
      `${JSON.stringify({
        version: 1,
        pid: recordedLauncherPid,
        processBirthToken: "2026-08-14T11:45:00.000Z",
      })}\n`,
    );
    const runtimeStatePath = join(productionRoot, "home/userdata/server-runtime.json");
    const writeRuntimeState = (pid, startedAt) =>
      writeFixture(
        runtimeStatePath,
        `${JSON.stringify({
          version: 1,
          pid,
          port: 17774,
          origin: "http://127.0.0.1:17774",
          startedAt,
        })}\n`,
      );
    writeRuntimeState(initialBackendPid, "2026-08-14T12:00:00.000Z");
    const selectedRelease = realpathSync(release);
    const executable = electronExecutablePath(selectedRelease);
    const launcherCommand = `${executable} ${join(selectedRelease, "apps/desktop/dist-electron/main.cjs")}`;
    const backendCommand = `${executable} ${join(selectedRelease, "apps/server/dist/bin.mjs")} --bootstrap-fd 3`;
    const processes = new Map();
    let replacementPending = false;
    processes.set(olderSupervisorPid, {
      alive: true,
      ppid: 1,
      birthToken: "2026-08-14T11:30:00.000Z",
      command: `${executable} dist-electron/main.cjs`,
      cwd: join(selectedRelease, "apps/desktop"),
      onSignal: (_signal, selected) => {
        selected.alive = false;
        processes.get(initialBackendPid).alive = false;
        const replacement = processes.get(replacementBackendPid);
        replacement.alive = false;
        replacement.listenerPort = undefined;
      },
    });
    processes.set(recordedLauncherPid, {
      alive: true,
      ppid: 1,
      birthToken: "2026-08-14T11:45:00.000Z",
      command: launcherCommand,
      cwd: selectedRelease,
      onSignal: (signal, selected) => {
        if (signal === "SIGKILL") selected.alive = false;
      },
    });
    processes.set(initialBackendPid, {
      alive: true,
      ppid: recordedLauncherPid,
      birthToken: "2026-08-14T11:59:59.000Z",
      command: backendCommand,
      cwd: selectedRelease,
      listenerPort: 17774,
      onSignal: (signal, selected) => {
        if (signal !== "SIGTERM") return;
        selected.alive = false;
        selected.listenerPort = undefined;
        replacementPending = true;
      },
    });
    const processControl = createProcessControl(processes, {
      onPause: () => {
        if (!replacementPending) return;
        replacementPending = false;
        processes.set(replacementBackendPid, {
          alive: true,
          ppid: olderSupervisorPid,
          birthToken: "2026-08-14T12:00:01.000Z",
          command: backendCommand,
          cwd: selectedRelease,
          listenerPort: 17774,
        });
        writeRuntimeState(replacementBackendPid, "2026-08-14T12:00:02.000Z");
      },
    });
    const { stop } = await import("./local-pipeline.mjs?runtime-handoff-test");

    await stop("production", { processControl });

    assert.deepStrictEqual(processControl.signals, [
      [recordedLauncherPid, "SIGTERM"],
      [recordedLauncherPid, "SIGKILL"],
      [initialBackendPid, "SIGTERM"],
      [olderSupervisorPid, "SIGTERM"],
    ]);
    assert.equal(processes.get(olderSupervisorPid).alive, false);
    assert.equal(processes.get(recordedLauncherPid).alive, false);
    assert.equal(processes.get(replacementBackendPid).alive, false);
    assert.equal(processControl.listenerPids(17774).length, 0);
    assert.equal(existsSync(markerPath), false);
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("does not signal a backend PID reused after the recorded runtime generation", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-reused-backend-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const release = join(productionRoot, "releases", "a".repeat(40));
  const backendPid = 4402;
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(release, "a".repeat(40));
    symlinkSync(release, join(productionRoot, "current"));
    writeFixture(
      join(productionRoot, "home/userdata/server-runtime.json"),
      `${JSON.stringify({
        version: 1,
        pid: backendPid,
        port: 17774,
        origin: "http://127.0.0.1:17774",
        startedAt: "2026-08-14T11:59:00.000Z",
      })}\n`,
    );
    const selectedRelease = realpathSync(release);
    const processes = new Map([
      [
        backendPid,
        {
          alive: true,
          ppid: 1,
          birthToken: "2026-08-14T11:59:30.000Z",
          command: `${electronExecutablePath(selectedRelease)} ${join(selectedRelease, "apps/server/dist/bin.mjs")} --bootstrap-fd 3`,
          cwd: selectedRelease,
          listenerPort: 17774,
        },
      ],
    ]);
    const processControl = createProcessControl(processes);
    const { stop } = await import("./local-pipeline.mjs?reused-backend-test");

    await expect(stop("production", { processControl })).rejects.toThrow(
      /process identity does not match/,
    );
    assert.deepStrictEqual(processControl.signals, []);

    processes.get(backendPid).birthToken = "2026-08-14T11:58:58.000Z";
    const inspectStableProcess = processControl.inspectProcess;
    let inspections = 0;
    processControl.inspectProcess = (pid) => {
      const inspected = inspectStableProcess(pid);
      inspections += 1;
      return inspections === 1
        ? inspected
        : { ...inspected, birthToken: "2026-08-14T11:58:59.000Z" };
    };
    await expect(stop("production", { processControl })).rejects.toThrow(/reused backend pid/);
    assert.deepStrictEqual(processControl.signals, []);
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("kills the same orphan backend after TERM removes its state and listener", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-stubborn-backend-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const release = join(productionRoot, "releases", "a".repeat(40));
  const runtimeStatePath = join(productionRoot, "home/userdata/server-runtime.json");
  const backendPid = 4502;
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(release, "a".repeat(40));
    symlinkSync(release, join(productionRoot, "current"));
    writeFixture(
      runtimeStatePath,
      `${JSON.stringify({
        version: 1,
        pid: backendPid,
        port: 17774,
        origin: "http://127.0.0.1:17774",
        startedAt: "2026-08-14T11:59:00.000Z",
      })}\n`,
    );
    const selectedRelease = realpathSync(release);
    const processes = new Map([
      [
        backendPid,
        {
          alive: true,
          ppid: 1,
          birthToken: "2026-08-14T11:58:59.000Z",
          command: `${electronExecutablePath(selectedRelease)} ${join(selectedRelease, "apps/server/dist/bin.mjs")} --bootstrap-fd 3`,
          cwd: selectedRelease,
          listenerPort: 17774,
          onSignal: (signal, selected) => {
            if (signal === "SIGTERM") {
              selected.listenerPort = undefined;
              rmSync(runtimeStatePath, { force: true });
            }
            if (signal === "SIGKILL") selected.alive = false;
          },
        },
      ],
    ]);
    const processControl = createProcessControl(processes);
    const { stop } = await import("./local-pipeline.mjs?stubborn-backend-test");

    await stop("production", { processControl });

    assert.deepStrictEqual(processControl.signals, [
      [backendPid, "SIGTERM"],
      [backendPid, "SIGKILL"],
    ]);
    assert.equal(processControl.listenerPids(17774).length, 0);
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("waits for a new expected-release runtime identity instead of an old HTTP responder", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-identity-readiness-"));
  const productionRoot = join(sandbox, "production");
  const release = join(productionRoot, "releases", "a".repeat(40));
  const runtimeStatePath = join(productionRoot, "home/userdata/server-runtime.json");
  const oldPid = 4601;
  const newPid = 4602;

  try {
    createCompleteRelease(release, "a".repeat(40));
    const selectedRelease = realpathSync(release);
    const serverCommand = `${electronExecutablePath(selectedRelease)} ${join(selectedRelease, "apps/server/dist/bin.mjs")} --bootstrap-fd 3`;
    const writeRuntimeState = (pid, startedAt) =>
      writeFixture(
        runtimeStatePath,
        `${JSON.stringify({
          version: 1,
          pid,
          port: 17774,
          origin: "http://127.0.0.1:17774",
          startedAt,
        })}\n`,
      );
    writeRuntimeState(oldPid, "2026-08-14T11:50:00.000Z");
    const processes = new Map([
      [
        oldPid,
        {
          alive: true,
          birthToken: "2026-08-14T11:49:59.000Z",
          command: serverCommand,
          cwd: selectedRelease,
          listenerPort: 17774,
        },
      ],
      [
        newPid,
        {
          alive: true,
          birthToken: "2026-08-14T12:00:00.000Z",
          command: serverCommand,
          cwd: selectedRelease,
        },
      ],
    ]);
    let swapped = false;
    let httpRequests = 0;
    const processControl = createProcessControl(processes, {
      onPause: () => {
        if (swapped) return;
        swapped = true;
        processes.get(oldPid).listenerPort = undefined;
        processes.get(newPid).listenerPort = 17774;
        writeRuntimeState(newPid, "2026-08-14T12:00:00.100Z");
      },
      httpReady: () => {
        httpRequests += 1;
        return true;
      },
    });
    const { waitForServer } = await import("./local-pipeline.mjs?identity-readiness-test");

    const identity = await waitForServer(
      {
        paths: {
          home: join(productionRoot, "home"),
          port: 17774,
        },
        expectedRelease: selectedRelease,
        rejectedRuntimeIdentity: {
          pid: oldPid,
          startedAt: "2026-08-14T11:50:00.000Z",
        },
        launchedAfter: Date.parse("2026-08-14T12:00:00.000Z"),
      },
      processControl,
    );

    assert.deepStrictEqual(identity, {
      pid: newPid,
      startedAt: "2026-08-14T12:00:00.100Z",
    });
    assert.equal(httpRequests, 1, "the rejected old runtime must not be probed as ready");

    const foreignPid = 4603;
    let handoffRequests = 0;
    const handoffControl = createProcessControl(processes, {
      httpReady: () => {
        handoffRequests += 1;
        processes.get(newPid).listenerPort = undefined;
        processes.set(foreignPid, {
          alive: true,
          birthToken: "2026-08-14T12:00:01.000Z",
          command: "/usr/bin/foreign --serve",
          cwd: sandbox,
          listenerPort: 17774,
        });
        return true;
      },
    });
    await expect(
      waitForServer(
        {
          paths: { home: join(productionRoot, "home"), port: 17774 },
          expectedRelease: selectedRelease,
          launchedAfter: Date.parse("2026-08-14T12:00:00.000Z"),
        },
        handoffControl,
      ),
    ).rejects.toThrow(/did not become ready/);
    assert.equal(handoffRequests, 1, "a foreign HTTP handoff must not be accepted");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("does not launch a replacement while a foreign listener remains after shutdown", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-residual-listener-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const release = join(productionRoot, "releases", "a".repeat(40));
  const backendPid = 4702;
  const foreignPid = 4703;
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(release, "a".repeat(40));
    symlinkSync(release, join(productionRoot, "current"));
    writeFixture(
      join(productionRoot, "home/userdata/server-runtime.json"),
      `${JSON.stringify({
        version: 1,
        pid: backendPid,
        port: 17774,
        origin: "http://127.0.0.1:17774",
        startedAt: "2026-08-14T11:59:00.000Z",
      })}\n`,
    );
    const selectedRelease = realpathSync(release);
    const processes = new Map([
      [
        backendPid,
        {
          alive: true,
          birthToken: "2026-08-14T11:58:59.000Z",
          command: `${electronExecutablePath(selectedRelease)} ${join(selectedRelease, "apps/server/dist/bin.mjs")} --bootstrap-fd 3`,
          cwd: selectedRelease,
          listenerPort: 17774,
          onSignal: (signal, selected) => {
            if (signal !== "SIGTERM") return;
            selected.alive = false;
            selected.listenerPort = undefined;
            processes.set(foreignPid, {
              alive: true,
              birthToken: "2026-08-14T12:00:00.000Z",
              command: "/usr/bin/foreign --serve",
              cwd: sandbox,
              listenerPort: 17774,
            });
          },
        },
      ],
    ]);
    const processControl = createProcessControl(processes);
    const launches = [];
    const { start } = await import("./local-pipeline.mjs?residual-listener-test");

    await expect(
      start("production", {
        processControl,
        launch: (...args) => launches.push(args),
        waitUntilReady: () => undefined,
        verify: () => undefined,
      }),
    ).rejects.toThrow(/remained occupied after shutdown/);
    assert.deepStrictEqual(launches, []);
    assert.deepStrictEqual(processControl.signals, [[backendPid, "SIGTERM"]]);
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("automatically rolls back after a failed replacement leaves an orphan backend", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-orphan-rollback-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const shaC = "c".repeat(40);
  const releaseA = join(productionRoot, "releases", shaA);
  const releaseB = join(productionRoot, "releases", shaB);
  const releaseC = join(productionRoot, "releases", shaC);
  const runtimeStatePath = join(productionRoot, "home/userdata/server-runtime.json");
  const launcherPath = join(productionRoot, "electron.pid");
  const initialBackendPid = 4801;
  const failedLauncherPid = 4802;
  const failedBackendPid = 4803;
  const restoredLauncherPid = 4804;
  const restoredBackendPid = 4805;
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    for (const [release, sha] of [
      [releaseA, shaA],
      [releaseB, shaB],
      [releaseC, shaC],
    ]) {
      createCompleteRelease(release, sha);
    }
    writeFixture(join(artifactRoot, "manifest.json"), `${JSON.stringify({ sha: shaC })}\n`);
    symlinkSync(releaseA, join(productionRoot, "current"));
    symlinkSync(releaseB, join(productionRoot, "previous"));
    const runtimeState = (pid, startedAt) => ({
      version: 1,
      pid,
      port: 17774,
      origin: "http://127.0.0.1:17774",
      startedAt,
    });
    const writeState = (pid, startedAt) =>
      writeFixture(runtimeStatePath, `${JSON.stringify(runtimeState(pid, startedAt))}\n`);
    const commandFor = (release) =>
      `${electronExecutablePath(realpathSync(release))} ${join(realpathSync(release), "apps/server/dist/bin.mjs")} --bootstrap-fd 3`;
    const launcherCommandFor = (release) =>
      `${electronExecutablePath(realpathSync(release))} ${join(realpathSync(release), "apps/desktop/dist-electron/main.cjs")}`;
    const stopOnTerm = (signal, selected) => {
      if (signal !== "SIGTERM") return;
      selected.alive = false;
      selected.listenerPort = undefined;
    };
    const initialStartedAt = new Date(Date.now() - 10_000).toISOString();
    writeState(initialBackendPid, initialStartedAt);
    const processes = new Map([
      [
        initialBackendPid,
        {
          alive: true,
          birthToken: new Date(Date.now() - 11_000).toISOString(),
          command: commandFor(releaseA),
          cwd: realpathSync(releaseA),
          listenerPort: 17774,
          onSignal: stopOnTerm,
        },
      ],
    ]);
    const processControl = createProcessControl(processes);
    const launches = [];
    let transactionWasRunning;
    const verificationFailure = new Error("replacement verification failed");
    const { deploy } = await import("./local-pipeline.mjs?orphan-rollback-test");
    const launch = (_name, _paths, release) => {
      const isFailedReplacement = realpathSync(release) === realpathSync(releaseC);
      const launcherPid = isFailedReplacement ? failedLauncherPid : restoredLauncherPid;
      const backendPid = isFailedReplacement ? failedBackendPid : restoredBackendPid;
      const startedAt = new Date(Date.now() + launches.length + 1_000).toISOString();
      const birthToken = new Date(Date.parse(startedAt) - 1_000).toISOString();
      launches.push(realpathSync(release));
      writeFixture(
        launcherPath,
        `${JSON.stringify({ version: 1, pid: launcherPid, processBirthToken: birthToken })}\n`,
      );
      writeState(backendPid, startedAt);
      processes.set(launcherPid, {
        alive: true,
        birthToken,
        command: launcherCommandFor(release),
        cwd: realpathSync(release),
        onSignal: stopOnTerm,
      });
      processes.set(backendPid, {
        alive: true,
        ppid: launcherPid,
        birthToken,
        command: commandFor(release),
        cwd: realpathSync(release),
        listenerPort: 17774,
        onSignal: stopOnTerm,
      });
    };

    await expect(
      deploy("production", {
        processControl,
        resolveTrackedHead: () => shaC,
        launch,
        verify: ({ expectedRelease }) => {
          if (realpathSync(expectedRelease) === realpathSync(releaseC)) {
            transactionWasRunning = JSON.parse(
              readFileSync(join(productionRoot, "operation-transaction.json"), "utf8"),
            ).wasRunning;
            throw verificationFailure;
          }
        },
      }),
    ).rejects.toBe(verificationFailure);

    assert.deepStrictEqual(launches, [realpathSync(releaseC), realpathSync(releaseA)]);
    assert.equal(
      transactionWasRunning,
      true,
      "an independently verified backend keeps interrupted recovery restartable",
    );
    assert.deepStrictEqual(
      processControl.signals.filter(
        ([pid]) => pid === failedLauncherPid || pid === failedBackendPid,
      ),
      [
        [failedLauncherPid, "SIGTERM"],
        [failedBackendPid, "SIGTERM"],
      ],
    );
    assert.equal(realpathSync(join(productionRoot, "current")), realpathSync(releaseA));
    assert.equal(realpathSync(join(productionRoot, "previous")), realpathSync(releaseB));
    assert.deepStrictEqual(
      JSON.parse(readFileSync(runtimeStatePath, "utf8")).pid,
      restoredBackendPid,
    );
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("recovers an interrupted deploy when the attempted launcher and prior backend coexist", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-interrupted-deploy-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const shaC = "c".repeat(40);
  const releaseA = join(productionRoot, "releases", shaA);
  const releaseB = join(productionRoot, "releases", shaB);
  const releaseC = join(productionRoot, "releases", shaC);
  const operationLock = join(productionRoot, "operation.lock");
  const operationTransaction = join(productionRoot, "operation-transaction.json");
  const attemptedLauncherPid = 4901;
  const priorSupervisorPid = 4902;
  const priorBackendPid = 4903;
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(releaseA, shaA);
    createCompleteRelease(releaseB, shaB);
    createCompleteRelease(releaseC, shaC);
    writeFixture(join(artifactRoot, "manifest.json"), `${JSON.stringify({ sha: shaC })}\n`);
    symlinkSync(releaseC, join(productionRoot, "current"));
    symlinkSync(releaseB, join(productionRoot, "previous"));
    writeFixture(
      operationLock,
      `${JSON.stringify({
        pid: 2_147_483_647,
        token: "interrupted-test-owner",
        operation: "deploy",
      })}\n`,
    );
    writeFixture(
      operationTransaction,
      `${JSON.stringify({
        version: 1,
        operation: "deploy",
        current: releaseA,
        previous: releaseB,
        currentSha: shaA,
        wasRunning: true,
      })}\n`,
    );
    writeFixture(
      join(productionRoot, "electron.pid"),
      `${JSON.stringify({
        version: 1,
        pid: attemptedLauncherPid,
        processBirthToken: "2026-08-14T12:00:00.000Z",
      })}\n`,
    );
    writeFixture(
      join(productionRoot, "home/userdata/server-runtime.json"),
      `${JSON.stringify({
        version: 1,
        pid: priorBackendPid,
        port: 17774,
        origin: "http://127.0.0.1:17774",
        startedAt: "2026-08-14T11:59:00.000Z",
      })}\n`,
    );
    const selectedReleaseA = realpathSync(releaseA);
    const selectedReleaseC = realpathSync(releaseC);
    const processes = new Map([
      [
        attemptedLauncherPid,
        {
          alive: true,
          ppid: 1,
          birthToken: "2026-08-14T12:00:00.000Z",
          command: `${electronExecutablePath(selectedReleaseC)} ${join(selectedReleaseC, "apps/desktop/dist-electron/main.cjs")}`,
          cwd: selectedReleaseC,
          onSignal: (_signal, selected) => {
            selected.alive = false;
          },
        },
      ],
      [
        priorSupervisorPid,
        {
          alive: true,
          ppid: 1,
          birthToken: "2026-08-14T11:30:00.000Z",
          command: `${electronExecutablePath(selectedReleaseA)} dist-electron/main.cjs`,
          cwd: join(selectedReleaseA, "apps/desktop"),
          onSignal: (_signal, selected) => {
            selected.alive = false;
            const backend = processes.get(priorBackendPid);
            backend.alive = false;
            backend.listenerPort = undefined;
          },
        },
      ],
      [
        priorBackendPid,
        {
          alive: true,
          ppid: priorSupervisorPid,
          birthToken: "2026-08-14T11:58:59.000Z",
          command: `${electronExecutablePath(selectedReleaseA)} ${join(selectedReleaseA, "apps/server/dist/bin.mjs")} --bootstrap-fd 3`,
          cwd: selectedReleaseA,
          listenerPort: 17774,
        },
      ],
    ]);
    const processControl = createProcessControl(processes);

    const { deploy } = await import("./local-pipeline.mjs?interrupted-deploy-recovery-test");
    const launches = [];
    const verifications = [];
    await deploy("production", {
      processControl,
      resolveTrackedHead: () => shaC,
      launch: (_name, _paths, release) => launches.push(realpathSync(release)),
      waitUntilReady: () => undefined,
      verify: ({ expectedRelease, expectedSha }) =>
        verifications.push([realpathSync(expectedRelease), expectedSha]),
    });

    assert.deepStrictEqual(
      {
        launches,
        verifications,
        current: realpathSync(join(productionRoot, "current")),
        previous: realpathSync(join(productionRoot, "previous")),
        operationLockExists: existsSync(operationLock),
        operationTransactionExists: existsSync(operationTransaction),
        signals: processControl.signals,
      },
      {
        launches: [realpathSync(releaseA), realpathSync(releaseC)],
        verifications: [
          [realpathSync(releaseA), shaA],
          [realpathSync(releaseC), shaC],
        ],
        current: realpathSync(releaseC),
        previous: realpathSync(releaseA),
        operationLockExists: false,
        operationTransactionExists: false,
        signals: [
          [attemptedLauncherPid, "SIGTERM"],
          [priorSupervisorPid, "SIGTERM"],
        ],
      },
      "the next deploy must recover the interrupted A/B snapshot before attempting C again",
    );
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("swaps complete production releases after a successful operator rollback", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-rollback-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const releaseA = join(productionRoot, "releases", shaA);
  const releaseB = join(productionRoot, "releases", shaB);
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(releaseA, shaA);
    createCompleteRelease(releaseB, shaB);
    symlinkSync(releaseA, join(productionRoot, "current"));
    symlinkSync(releaseB, join(productionRoot, "previous"));

    const { rollback } = await import("./local-pipeline.mjs?rollback-success-test");
    const transitions = [];
    let runningRelease;
    await rollback("production", {
      processControl: createQuiescentProcessControl(),
      verify: () => undefined,
      launch: (_name, _paths, release) => {
        runningRelease = release;
        transitions.push(["launch", release]);
      },
      waitUntilReady: () => transitions.push(["ready", runningRelease]),
    });

    const selectedReleaseA = realpathSync(releaseA);
    const selectedReleaseB = realpathSync(releaseB);
    assert.deepStrictEqual(transitions, [
      ["launch", selectedReleaseB],
      ["ready", selectedReleaseB],
    ]);
    assert.deepStrictEqual(
      {
        current: realpathSync(join(productionRoot, "current")),
        previous: realpathSync(join(productionRoot, "previous")),
      },
      { current: selectedReleaseB, previous: selectedReleaseA },
      "successful operator rollback must swap current and previous",
    );
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("restores the release snapshot when operator rollback cannot launch", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-rollback-failure-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const releaseA = join(productionRoot, "releases", shaA);
  const releaseB = join(productionRoot, "releases", shaB);
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(releaseA, shaA);
    createCompleteRelease(releaseB, shaB);
    symlinkSync(releaseA, join(productionRoot, "current"));
    symlinkSync(releaseB, join(productionRoot, "previous"));

    const selectedReleaseA = realpathSync(releaseA);
    const selectedReleaseB = realpathSync(releaseB);
    const rollbackFailure = new Error("simulated rollback launch failure");
    const { rollback } = await import("./local-pipeline.mjs?rollback-failure-test");
    const launches = [];
    let rollbackError;
    try {
      await rollback("production", {
        processControl: createQuiescentProcessControl(),
        verify: () => undefined,
        launch: (_name, _paths, release) => {
          launches.push(release);
          if (release === selectedReleaseB) throw rollbackFailure;
        },
        waitUntilReady: () => undefined,
      });
    } catch (error) {
      rollbackError = error;
    }

    assert.equal(rollbackError, rollbackFailure, "rollback must report the original B failure");
    assert.deepStrictEqual(
      {
        launches,
        current: realpathSync(join(productionRoot, "current")),
        previous: realpathSync(join(productionRoot, "previous")),
      },
      {
        launches: [selectedReleaseB, selectedReleaseA],
        current: selectedReleaseA,
        previous: selectedReleaseB,
      },
      "failed operator rollback must relaunch A and restore the exact A/B snapshot",
    );
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("recovers when production verification rejects the replacement", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-deploy-verification-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const shaC = "c".repeat(40);
  const releaseA = join(productionRoot, "releases", shaA);
  const releaseB = join(productionRoot, "releases", shaB);
  const releaseC = join(productionRoot, "releases", shaC);
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(releaseA, shaA);
    createCompleteRelease(releaseB, shaB);
    createCompleteRelease(releaseC, shaC);
    writeFixture(join(artifactRoot, "manifest.json"), `${JSON.stringify({ sha: shaC })}\n`);
    symlinkSync(releaseA, join(productionRoot, "current"));
    symlinkSync(releaseB, join(productionRoot, "previous"));

    const selectedReleaseA = realpathSync(releaseA);
    const selectedReleaseB = realpathSync(releaseB);
    const selectedReleaseC = realpathSync(releaseC);
    const verificationFailure = new Error("simulated C revision verification failure");
    const { deploy } = await import("./local-pipeline.mjs?deploy-verification-failure-test");
    const launches = [];
    const verifications = [];
    let deployError;
    try {
      await deploy("production", {
        processControl: createQuiescentProcessControl(),
        resolveTrackedHead: () => shaC,
        launch: (_name, _paths, release) => launches.push(realpathSync(release)),
        waitUntilReady: () => undefined,
        verify: ({ expectedRelease, expectedSha }) => {
          const selectedRelease = realpathSync(expectedRelease);
          verifications.push([selectedRelease, expectedSha]);
          if (selectedRelease === selectedReleaseC) throw verificationFailure;
        },
      });
    } catch (error) {
      deployError = error;
    }

    assert.deepStrictEqual(
      {
        verifications,
        launches,
        current: realpathSync(join(productionRoot, "current")),
        previous: realpathSync(join(productionRoot, "previous")),
      },
      {
        verifications: [
          [selectedReleaseC, shaC],
          [selectedReleaseA, shaA],
        ],
        launches: [selectedReleaseC, selectedReleaseA],
        current: selectedReleaseA,
        previous: selectedReleaseB,
      },
      "failed C verification must reverify recovered A and restore the exact A/B snapshot",
    );
    assert.equal(
      deployError,
      verificationFailure,
      "deploy must report the original C verification failure",
    );
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("recovers when production verification rejects operator rollback", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-rollback-verification-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const releaseA = join(productionRoot, "releases", shaA);
  const releaseB = join(productionRoot, "releases", shaB);
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(releaseA, shaA);
    createCompleteRelease(releaseB, shaB);
    symlinkSync(releaseA, join(productionRoot, "current"));
    symlinkSync(releaseB, join(productionRoot, "previous"));

    const selectedReleaseA = realpathSync(releaseA);
    const selectedReleaseB = realpathSync(releaseB);
    const verificationFailure = new Error("simulated B revision verification failure");
    const { rollback } = await import("./local-pipeline.mjs?rollback-verification-failure-test");
    const launches = [];
    const verifications = [];
    let rollbackError;
    try {
      await rollback("production", {
        processControl: createQuiescentProcessControl(),
        launch: (_name, _paths, release) => launches.push(realpathSync(release)),
        waitUntilReady: () => undefined,
        verify: ({ expectedRelease, expectedSha }) => {
          const selectedRelease = realpathSync(expectedRelease);
          verifications.push([selectedRelease, expectedSha]);
          if (selectedRelease === selectedReleaseB) throw verificationFailure;
        },
      });
    } catch (error) {
      rollbackError = error;
    }

    assert.deepStrictEqual(
      {
        verifications,
        launches,
        current: realpathSync(join(productionRoot, "current")),
        previous: realpathSync(join(productionRoot, "previous")),
      },
      {
        verifications: [
          [selectedReleaseB, shaB],
          [selectedReleaseA, shaA],
        ],
        launches: [selectedReleaseB, selectedReleaseA],
        current: selectedReleaseA,
        previous: selectedReleaseB,
      },
      "failed B verification must reverify recovered A and restore the exact A/B snapshot",
    );
    assert.equal(
      rollbackError,
      verificationFailure,
      "rollback must report the original B verification failure",
    );
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("records both failures when production deploy recovery cannot verify", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-deploy-compound-failure-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const shaC = "c".repeat(40);
  const releaseA = join(productionRoot, "releases", shaA);
  const releaseB = join(productionRoot, "releases", shaB);
  const releaseC = join(productionRoot, "releases", shaC);
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(releaseA, shaA);
    createCompleteRelease(releaseB, shaB);
    createCompleteRelease(releaseC, shaC);
    writeFixture(join(artifactRoot, "manifest.json"), `${JSON.stringify({ sha: shaC })}\n`);
    symlinkSync(releaseA, join(productionRoot, "current"));
    symlinkSync(releaseB, join(productionRoot, "previous"));

    const selectedReleaseA = realpathSync(releaseA);
    const selectedReleaseB = realpathSync(releaseB);
    const selectedReleaseC = realpathSync(releaseC);
    const initiatingError = new Error("simulated C verification failure");
    const recoveryError = new Error("simulated A recovery verification failure");
    const { deploy } = await import("./local-pipeline.mjs?deploy-compound-recovery-failure-test");
    const launches = [];
    const verifications = [];
    let deployError;
    try {
      await deploy("production", {
        processControl: createQuiescentProcessControl(),
        resolveTrackedHead: () => shaC,
        launch: (_name, _paths, release) => launches.push(realpathSync(release)),
        waitUntilReady: () => undefined,
        verify: ({ expectedRelease, expectedSha }) => {
          const selectedRelease = realpathSync(expectedRelease);
          verifications.push([selectedRelease, expectedSha]);
          if (selectedRelease === selectedReleaseC) throw initiatingError;
          if (selectedRelease === selectedReleaseA) throw recoveryError;
        },
      });
    } catch (error) {
      deployError = error;
    }

    const markerPath = join(productionRoot, "manual-intervention-required.json");
    const markerContents = existsSync(markerPath) ? readFileSync(markerPath, "utf8") : undefined;
    const exposedErrors = deployError instanceof AggregateError ? deployError.errors : [];
    assert.deepStrictEqual(
      {
        verifications,
        launches,
        current: realpathSync(join(productionRoot, "current")),
        previous: realpathSync(join(productionRoot, "previous")),
        aggregateError: deployError instanceof AggregateError,
        exposesInitiatingError: exposedErrors.includes(initiatingError),
        exposesRecoveryError: exposedErrors.includes(recoveryError),
        markerExists: markerContents !== undefined,
        operationTransactionExists: existsSync(join(productionRoot, "operation-transaction.json")),
        markerIdentifiesDeploy: markerContents?.includes("deploy") ?? false,
        markerIncludesInitiatingMessage: markerContents?.includes(initiatingError.message) ?? false,
        markerIncludesRecoveryMessage: markerContents?.includes(recoveryError.message) ?? false,
      },
      {
        verifications: [
          [selectedReleaseC, shaC],
          [selectedReleaseA, shaA],
        ],
        launches: [selectedReleaseC, selectedReleaseA],
        current: selectedReleaseA,
        previous: selectedReleaseB,
        aggregateError: true,
        exposesInitiatingError: true,
        exposesRecoveryError: true,
        markerExists: true,
        operationTransactionExists: true,
        markerIdentifiesDeploy: true,
        markerIncludesInitiatingMessage: true,
        markerIncludesRecoveryMessage: true,
      },
      "failed recovery must preserve both errors and durable manual-intervention state",
    );
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("records both failures when operator rollback recovery cannot verify", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-rollback-compound-failure-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const releaseA = join(productionRoot, "releases", shaA);
  const releaseB = join(productionRoot, "releases", shaB);
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(releaseA, shaA);
    createCompleteRelease(releaseB, shaB);
    symlinkSync(releaseA, join(productionRoot, "current"));
    symlinkSync(releaseB, join(productionRoot, "previous"));

    const selectedReleaseA = realpathSync(releaseA);
    const selectedReleaseB = realpathSync(releaseB);
    const initiatingError = new Error("simulated B rollback verification failure");
    const recoveryError = new Error("simulated A rollback recovery verification failure");
    const { rollback } = await import("./local-pipeline.mjs?rollback-compound-recovery-test");
    const launches = [];
    const verifications = [];
    let rollbackError;
    try {
      await rollback("production", {
        processControl: createQuiescentProcessControl(),
        launch: (_name, _paths, release) => launches.push(realpathSync(release)),
        waitUntilReady: () => undefined,
        verify: ({ expectedRelease, expectedSha }) => {
          const selectedRelease = realpathSync(expectedRelease);
          verifications.push([selectedRelease, expectedSha]);
          if (selectedRelease === selectedReleaseB) throw initiatingError;
          if (selectedRelease === selectedReleaseA) throw recoveryError;
        },
      });
    } catch (error) {
      rollbackError = error;
    }

    const markerPath = join(productionRoot, "manual-intervention-required.json");
    const markerContents = existsSync(markerPath) ? readFileSync(markerPath, "utf8") : undefined;
    const exposedErrors = rollbackError instanceof AggregateError ? rollbackError.errors : [];
    assert.deepStrictEqual(
      {
        verifications,
        launches,
        current: realpathSync(join(productionRoot, "current")),
        previous: realpathSync(join(productionRoot, "previous")),
        aggregateError: rollbackError instanceof AggregateError,
        exposesInitiatingError: exposedErrors.includes(initiatingError),
        exposesRecoveryError: exposedErrors.includes(recoveryError),
        markerExists: markerContents !== undefined,
        markerIdentifiesRollback: markerContents?.includes("rollback") ?? false,
        markerIncludesInitiatingMessage: markerContents?.includes(initiatingError.message) ?? false,
        markerIncludesRecoveryMessage: markerContents?.includes(recoveryError.message) ?? false,
      },
      {
        verifications: [
          [selectedReleaseB, shaB],
          [selectedReleaseA, shaA],
        ],
        launches: [selectedReleaseB, selectedReleaseA],
        current: selectedReleaseA,
        previous: selectedReleaseB,
        aggregateError: true,
        exposesInitiatingError: true,
        exposesRecoveryError: true,
        markerExists: true,
        markerIdentifiesRollback: true,
        markerIncludesInitiatingMessage: true,
        markerIncludesRecoveryMessage: true,
      },
      "failed rollback recovery must preserve both errors and durable intervention state",
    );
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("preserves the rollback target across an explicit same-SHA deploy retry", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-same-sha-retry-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const releaseA = join(productionRoot, "releases", shaA);
  const releaseB = join(productionRoot, "releases", shaB);
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(releaseA, shaA);
    createCompleteRelease(releaseB, shaB);
    writeFixture(join(artifactRoot, "manifest.json"), `${JSON.stringify({ sha: shaB })}\n`);
    symlinkSync(releaseA, join(productionRoot, "current"));

    const selectedReleaseA = realpathSync(releaseA);
    const selectedReleaseB = realpathSync(releaseB);
    const { deploy, rollback } = await import("./local-pipeline.mjs?same-sha-retry-rollback-test");
    const transitions = [];
    let runningRelease;
    const operationOptions = {
      processControl: createQuiescentProcessControl(),
      launch: (_name, _paths, release) => {
        runningRelease = realpathSync(release);
        transitions.push(["launch", runningRelease]);
      },
      waitUntilReady: () => transitions.push(["ready", runningRelease]),
      verify: ({ expectedRelease, expectedSha }) =>
        transitions.push(["verify", realpathSync(expectedRelease), expectedSha]),
    };
    const deployOptions = {
      ...operationOptions,
      resolveTrackedHead: () => {
        transitions.push(["head", shaB]);
        return shaB;
      },
    };

    await deploy("production", deployOptions);
    const afterFirstDeploy = {
      current: realpathSync(join(productionRoot, "current")),
      previous: realpathSync(join(productionRoot, "previous")),
    };

    await deploy("production", deployOptions);
    const afterSameShaRetry = {
      current: realpathSync(join(productionRoot, "current")),
      previous: realpathSync(join(productionRoot, "previous")),
    };

    assert.deepStrictEqual(
      { afterFirstDeploy, afterSameShaRetry },
      {
        afterFirstDeploy: { current: selectedReleaseB, previous: selectedReleaseA },
        afterSameShaRetry: { current: selectedReleaseB, previous: selectedReleaseA },
      },
      "an explicit same-SHA retry must preserve the existing rollback target",
    );

    await rollback("production", operationOptions);
    const afterRollback = {
      current: realpathSync(join(productionRoot, "current")),
      previous: realpathSync(join(productionRoot, "previous")),
    };

    assert.deepStrictEqual(
      {
        transitions,
        afterFirstDeploy,
        afterSameShaRetry,
        afterRollback,
      },
      {
        transitions: [
          ["head", shaB],
          ["head", shaB],
          ["launch", selectedReleaseB],
          ["ready", selectedReleaseB],
          ["verify", selectedReleaseB, shaB],
          ["head", shaB],
          ["head", shaB],
          ["launch", selectedReleaseB],
          ["ready", selectedReleaseB],
          ["verify", selectedReleaseB, shaB],
          ["launch", selectedReleaseA],
          ["ready", selectedReleaseA],
          ["verify", selectedReleaseA, shaA],
        ],
        afterFirstDeploy: { current: selectedReleaseB, previous: selectedReleaseA },
        afterSameShaRetry: { current: selectedReleaseB, previous: selectedReleaseA },
        afterRollback: { current: selectedReleaseA, previous: selectedReleaseB },
      },
    );
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("releases the production operation lock when CLI deploy validation fails", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-cli-lock-cleanup-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const repositoryRoot = resolve(import.meta.dirname, "../..");
  const operationLock = join(runtimeRoot, "production", "operation.lock");

  try {
    mkdirSync(artifactRoot, { recursive: true });
    const result = spawnSync(
      process.execPath,
      ["scripts/gocd/local-pipeline.mjs", "deploy", "production"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          T3_PIPELINE_RUNTIME_ROOT: runtimeRoot,
          T3_PIPELINE_ARTIFACT_ROOT: artifactRoot,
        },
      },
    );

    assert.notEqual(result.status, 0, "CLI deploy must reject a missing artifact manifest");
    assert.match(result.stderr, /Missing .*manifest\.json; run the build stage first\./);
    assert.equal(
      existsSync(operationLock),
      false,
      "failed CLI deploy must not strand the production operation lock",
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("clears manual intervention only after a locked production start verifies", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-verified-start-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const shaA = "a".repeat(40);
  const releaseA = join(productionRoot, "releases", shaA);
  const operationLock = join(productionRoot, "operation.lock");
  const interventionMarker = join(productionRoot, "manual-intervention-required.json");
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(releaseA, shaA);
    symlinkSync(releaseA, join(productionRoot, "current"));
    writeFixture(
      interventionMarker,
      `${JSON.stringify({ status: "manual-intervention-required" })}\n`,
    );

    const selectedReleaseA = realpathSync(releaseA);
    const { start } = await import("./local-pipeline.mjs?verified-start-test");
    const transitions = [];
    let runningRelease;
    await start("production", {
      processControl: createQuiescentProcessControl(),
      launch: (_name, _paths, release, sha) => {
        runningRelease = realpathSync(release);
        transitions.push([
          "launch",
          runningRelease,
          sha,
          existsSync(operationLock),
          existsSync(interventionMarker),
        ]);
      },
      waitUntilReady: () =>
        transitions.push([
          "ready",
          runningRelease,
          existsSync(operationLock),
          existsSync(interventionMarker),
        ]),
      verify: ({ expectedRelease, expectedSha }) =>
        transitions.push([
          "verify",
          realpathSync(expectedRelease),
          expectedSha,
          existsSync(operationLock),
          existsSync(interventionMarker),
        ]),
    });

    assert.deepStrictEqual(
      {
        transitions,
        current: realpathSync(join(productionRoot, "current")),
        operationLockExistsAfterStart: existsSync(operationLock),
        interventionMarkerExistsAfterStart: existsSync(interventionMarker),
      },
      {
        transitions: [
          ["launch", selectedReleaseA, shaA, true, true],
          ["ready", selectedReleaseA, true, true],
          ["verify", selectedReleaseA, shaA, true, true],
        ],
        current: selectedReleaseA,
        operationLockExistsAfterStart: false,
        interventionMarkerExistsAfterStart: false,
      },
      "production start must hold its lock and retain intervention state through verification",
    );
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("records an unrecoverable legacy fallback when bootstrap verification fails", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-legacy-bootstrap-failure-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const shaA = "a".repeat(40);
  const shaC = "c".repeat(40);
  const legacyRelease = join(sandbox, "legacy-production");
  const releaseC = join(productionRoot, "releases", shaC);
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    writeFixture(join(legacyRelease, "manifest.json"), `${JSON.stringify({ sha: shaA })}\n`);
    createCompleteRelease(releaseC, shaC);
    writeFixture(join(artifactRoot, "manifest.json"), `${JSON.stringify({ sha: shaC })}\n`);
    symlinkSync(legacyRelease, join(productionRoot, "current"));

    const selectedLegacyRelease = realpathSync(legacyRelease);
    const selectedReleaseC = realpathSync(releaseC);
    const initiatingError = new Error("simulated bootstrap C verification failure");
    const { deploy } = await import("./local-pipeline.mjs?legacy-bootstrap-failure-test");
    const launches = [];
    const verifications = [];
    let deployError;
    try {
      await deploy("production", {
        processControl: createQuiescentProcessControl(),
        resolveTrackedHead: () => shaC,
        launch: (_name, _paths, release) => launches.push(realpathSync(release)),
        waitUntilReady: () => undefined,
        verify: ({ expectedRelease, expectedSha }) => {
          const selectedRelease = realpathSync(expectedRelease);
          verifications.push([selectedRelease, expectedSha]);
          if (selectedRelease === selectedReleaseC) throw initiatingError;
        },
      });
    } catch (error) {
      deployError = error;
    }

    const exposedErrors = deployError instanceof AggregateError ? deployError.errors : [];
    const recoveryError = exposedErrors.find((error) => error !== initiatingError);
    const markerPath = join(productionRoot, "manual-intervention-required.json");
    const markerContents = existsSync(markerPath) ? readFileSync(markerPath, "utf8") : undefined;
    assert.deepStrictEqual(
      {
        launches,
        verifications,
        current: realpathSync(join(productionRoot, "current")),
        previousExists: existsSync(join(productionRoot, "previous")),
        aggregateError: deployError instanceof AggregateError,
        exposesInitiatingError: exposedErrors.includes(initiatingError),
        exposesUnrecoverableFallback:
          recoveryError instanceof Error &&
          /prior production release cannot be relaunched automatically/i.test(
            recoveryError.message,
          ),
        markerIdentifiesDeploy: markerContents?.includes("deploy") ?? false,
        markerIncludesInitiatingMessage: markerContents?.includes(initiatingError.message) ?? false,
        markerIncludesRecoveryMessage:
          recoveryError instanceof Error &&
          (markerContents?.includes(recoveryError.message) ?? false),
      },
      {
        launches: [selectedReleaseC],
        verifications: [[selectedReleaseC, shaC]],
        current: selectedLegacyRelease,
        previousExists: false,
        aggregateError: true,
        exposesInitiatingError: true,
        exposesUnrecoverableFallback: true,
        markerIdentifiesDeploy: true,
        markerIncludesInitiatingMessage: true,
        markerIncludesRecoveryMessage: true,
      },
      "failed bootstrap must restore but never relaunch an incomplete legacy release",
    );
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("rejects unavailable and malformed tracked heads before production mutation", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-head-resolution-failure-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const shaC = "c".repeat(40);
  const releaseA = join(productionRoot, "releases", shaA);
  const releaseB = join(productionRoot, "releases", shaB);
  const releaseC = join(productionRoot, "releases", shaC);
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(releaseA, shaA);
    createCompleteRelease(releaseB, shaB);
    createCompleteRelease(releaseC, shaC);
    writeFixture(join(artifactRoot, "manifest.json"), `${JSON.stringify({ sha: shaC })}\n`);
    symlinkSync(releaseA, join(productionRoot, "current"));
    symlinkSync(releaseB, join(productionRoot, "previous"));

    const selectedReleaseA = realpathSync(releaseA);
    const selectedReleaseB = realpathSync(releaseB);
    const unavailableError = new Error("simulated fork main lookup unavailable");
    const malformedHead = "not-a-valid-git-sha";
    const { deploy } = await import("./local-pipeline.mjs?tracked-head-failures-test");
    const launches = [];
    const verifications = [];
    const errors = [];
    for (const resolveTrackedHead of [
      () => {
        throw unavailableError;
      },
      () => malformedHead,
    ]) {
      try {
        await deploy("production", {
          processControl: createQuiescentProcessControl(),
          resolveTrackedHead,
          launch: (_name, _paths, release) => launches.push(realpathSync(release)),
          waitUntilReady: () => undefined,
          verify: (options) => verifications.push(options),
        });
      } catch (error) {
        errors.push(error);
      }
    }

    assert.deepStrictEqual(
      {
        unavailableErrorPreserved: errors[0] === unavailableError,
        malformedHeadRejected:
          errors[1] instanceof Error && errors[1].message.includes(malformedHead),
        launches,
        verifications,
        current: realpathSync(join(productionRoot, "current")),
        previous: realpathSync(join(productionRoot, "previous")),
      },
      {
        unavailableErrorPreserved: true,
        malformedHeadRejected: true,
        launches: [],
        verifications: [],
        current: selectedReleaseA,
        previous: selectedReleaseB,
      },
      "tracked-head failures must reject before stopping or repointing production",
    );
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("holds the production operation lock through injected deploy verification", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-locked-verification-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const shaA = "a".repeat(40);
  const shaC = "c".repeat(40);
  const releaseA = join(productionRoot, "releases", shaA);
  const releaseC = join(productionRoot, "releases", shaC);
  const operationLock = join(productionRoot, "operation.lock");
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(releaseA, shaA);
    createCompleteRelease(releaseC, shaC);
    writeFixture(join(artifactRoot, "manifest.json"), `${JSON.stringify({ sha: shaC })}\n`);
    symlinkSync(releaseA, join(productionRoot, "current"));

    const selectedReleaseA = realpathSync(releaseA);
    const selectedReleaseC = realpathSync(releaseC);
    const { deploy } = await import("./local-pipeline.mjs?locked-deploy-verification-test");
    const verificationObservations = [];
    await deploy("production", {
      processControl: createQuiescentProcessControl(),
      resolveTrackedHead: () => shaC,
      launch: () => undefined,
      waitUntilReady: () => undefined,
      verify: ({ expectedRelease, expectedSha }) =>
        verificationObservations.push({
          release: realpathSync(expectedRelease),
          sha: expectedSha,
          operationLockExists: existsSync(operationLock),
        }),
    });

    assert.deepStrictEqual(
      {
        verificationObservations,
        current: realpathSync(join(productionRoot, "current")),
        previous: realpathSync(join(productionRoot, "previous")),
        operationLockExistsAfterDeploy: existsSync(operationLock),
      },
      {
        verificationObservations: [
          { release: selectedReleaseC, sha: shaC, operationLockExists: true },
        ],
        current: selectedReleaseC,
        previous: selectedReleaseA,
        operationLockExistsAfterDeploy: false,
      },
    );
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("does not advertise an incomplete legacy release after successful bootstrap", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-legacy-bootstrap-success-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const shaA = "a".repeat(40);
  const shaC = "c".repeat(40);
  const legacyRelease = join(sandbox, "legacy-production");
  const releaseC = join(productionRoot, "releases", shaC);
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    writeFixture(join(legacyRelease, "manifest.json"), `${JSON.stringify({ sha: shaA })}\n`);
    createCompleteRelease(releaseC, shaC);
    writeFixture(join(artifactRoot, "manifest.json"), `${JSON.stringify({ sha: shaC })}\n`);
    symlinkSync(legacyRelease, join(productionRoot, "current"));

    const selectedReleaseC = realpathSync(releaseC);
    const { deploy } = await import("./local-pipeline.mjs?legacy-bootstrap-success-test");
    const transitions = [];
    await deploy("production", {
      processControl: createQuiescentProcessControl(),
      resolveTrackedHead: () => shaC,
      launch: (_name, _paths, release) => transitions.push(["launch", realpathSync(release)]),
      waitUntilReady: () => undefined,
      verify: ({ expectedRelease, expectedSha }) =>
        transitions.push(["verify", realpathSync(expectedRelease), expectedSha]),
    });

    assert.deepStrictEqual(
      {
        transitions,
        current: realpathSync(join(productionRoot, "current")),
        previousExists: existsSync(join(productionRoot, "previous")),
      },
      {
        transitions: [
          ["launch", selectedReleaseC],
          ["verify", selectedReleaseC, shaC],
        ],
        current: selectedReleaseC,
        previousExists: false,
      },
      "successful bootstrap must not expose an incomplete legacy release as rollback",
    );
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("rejects rollback when the previous release lacks its Electron executable", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-incomplete-electron-rollback-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const releaseA = join(productionRoot, "releases", shaA);
  const releaseB = join(productionRoot, "releases", shaB);
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    createCompleteRelease(releaseA, shaA);
    createCompleteRelease(releaseB, shaB);
    rmSync(electronExecutablePath(releaseB));
    symlinkSync(releaseA, join(productionRoot, "current"));
    symlinkSync(releaseB, join(productionRoot, "previous"));

    const selectedReleaseA = realpathSync(releaseA);
    const selectedReleaseB = realpathSync(releaseB);
    const { rollback } = await import("./local-pipeline.mjs?incomplete-electron-rollback-test");
    const launches = [];
    const verifications = [];
    let rollbackError;
    try {
      await rollback("production", {
        processControl: createQuiescentProcessControl(),
        launch: (_name, _paths, release) => launches.push(realpathSync(release)),
        waitUntilReady: () => undefined,
        verify: (options) => verifications.push(options),
      });
    } catch (error) {
      rollbackError = error;
    }

    assert.deepStrictEqual(
      {
        rejected: rollbackError instanceof Error,
        launches,
        verifications,
        current: realpathSync(join(productionRoot, "current")),
        previous: realpathSync(join(productionRoot, "previous")),
      },
      {
        rejected: true,
        launches: [],
        verifications: [],
        current: selectedReleaseA,
        previous: selectedReleaseB,
      },
      "rollback must reject an incomplete Electron runtime before production mutation",
    );
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("prunes superseded releases after a deploy while retaining pointer targets", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-prune-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const shas = ["a", "b", "c", "d", "e", "f"].map((letter) => letter.repeat(40));
  const releases = shas.map((sha) => join(productionRoot, "releases", sha));
  const [releaseA, releaseB, , releaseD, releaseE, releaseF] = releases;
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    releases.forEach((release, index) => {
      createCompleteRelease(release, shas[index]);
      // Age the directories so retention sees a deterministic newest-first order.
      const modifiedAt = new Date(Date.UTC(2026, 0, index + 1));
      utimesSync(release, modifiedAt, modifiedAt);
    });
    writeFixture(join(artifactRoot, "manifest.json"), `${JSON.stringify({ sha: shas[5] })}\n`);
    // The oldest release is live, so pruning must keep it despite its age.
    symlinkSync(releaseA, join(productionRoot, "current"));
    symlinkSync(releaseB, join(productionRoot, "previous"));

    const { deploy } = await import("./local-pipeline.mjs?release-retention-test");
    await deploy("production", {
      processControl: createQuiescentProcessControl(),
      resolveTrackedHead: () => shas[5],
      verify: () => undefined,
      launch: () => undefined,
      waitUntilReady: () => undefined,
    });

    assert.deepStrictEqual(
      {
        current: realpathSync(join(productionRoot, "current")),
        previous: realpathSync(join(productionRoot, "previous")),
        surviving: releases.filter(existsSync).sort(),
      },
      {
        current: realpathSync(releaseF),
        previous: realpathSync(releaseA),
        surviving: [releaseA, releaseD, releaseE, releaseF].sort(),
      },
      "retention keeps the three newest releases plus whatever the pointers resolve to",
    );
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("attaches a desktop debugging port to the launch only when configured", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-debug-port-"));
  const release = join(sandbox, "release");
  const runtimeRoot = join(sandbox, "runtime");
  const sha = "a".repeat(40);
  const previousDebugPort = process.env.T3_PIPELINE_DESKTOP_DEBUG_PORT;
  const paths = {
    base: runtimeRoot,
    home: join(runtimeRoot, "home"),
    pid: join(runtimeRoot, "electron.pid"),
    log: join(runtimeRoot, "electron.log"),
    port: 17774,
  };

  try {
    createCompleteRelease(release, sha);
    const { launchRelease } = await import("./local-pipeline.mjs?desktop-debug-port-test");
    const launch = () => {
      const launches = [];
      launchRelease("production", paths, release, sha, {
        spawnProcess: (_command, args) => {
          launches.push(args);
          return { pid: 4242, unref() {} };
        },
        readBirthToken: () => "2026-08-14T11:59:00.000Z",
      });
      rmSync(paths.pid, { force: true });
      return launches[0];
    };

    delete process.env.T3_PIPELINE_DESKTOP_DEBUG_PORT;
    const withoutPort = launch();

    process.env.T3_PIPELINE_DESKTOP_DEBUG_PORT = "9222";
    const withPort = launch();

    assert.deepStrictEqual(
      { withoutPort, withPort },
      {
        withoutPort: [join(release, "apps/desktop/dist-electron/main.cjs")],
        withPort: [
          join(release, "apps/desktop/dist-electron/main.cjs"),
          "--remote-debugging-port=9222",
        ],
      },
      "the debugging endpoint must be opt-in so ordinary deploys are unchanged",
    );

    process.env.T3_PIPELINE_DESKTOP_DEBUG_PORT = "not-a-port";
    expect(launch).toThrow("T3_PIPELINE_DESKTOP_DEBUG_PORT");
    process.env.T3_PIPELINE_DESKTOP_DEBUG_PORT = "80";
    expect(launch).toThrow("between 1024 and 65535");
  } finally {
    if (previousDebugPort === undefined) delete process.env.T3_PIPELINE_DESKTOP_DEBUG_PORT;
    else process.env.T3_PIPELINE_DESKTOP_DEBUG_PORT = previousDebugPort;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// The pipeline spawns launchers detached and unref'd, so it stays their parent
// without reaping them: a launcher it kills within the same run lingers as a
// zombie and kill(pid, 0) keeps succeeding. Counting that as alive is what
// produced "launcher pid N survived SIGKILL" against an already-exited process.
it("treats an unreaped zombie as exited", async () => {
  const { isAlive } = await import("./local-pipeline.mjs?zombie-liveness-test");

  assert.equal(isAlive(process.pid, { probeState: () => "R" }), true);
  assert.equal(isAlive(process.pid, { probeState: () => "S+" }), true);
  assert.equal(isAlive(process.pid, { probeState: () => "Z" }), false);
  assert.equal(isAlive(process.pid, { probeState: () => "Z+" }), false);
  // An unreadable state must not turn a live process into a dead one.
  assert.equal(isAlive(process.pid, { probeState: () => "" }), true);
  // A pid that does not exist stays dead regardless of the probe.
  assert.equal(isAlive(2_147_483_646, { probeState: () => "R" }), false);
});
