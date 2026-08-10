import { assert, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const { spawn, spawnSync } = NodeChildProcess;
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
    assert.equal(readFileSync(join(runtimeRoot, "electron.pid"), "utf8"), "4242\n");
  } finally {
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

it("refuses to stop a live pid that does not own the production runtime", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-unowned-launcher-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const launcherPid = join(productionRoot, "electron.pid");
  const operationLock = join(productionRoot, "operation.lock");
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;
  const unrelatedProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    await new Promise((resolveSpawn, rejectSpawn) => {
      unrelatedProcess.once("spawn", resolveSpawn);
      unrelatedProcess.once("error", rejectSpawn);
    });
    assert.ok(unrelatedProcess.pid, "the unrelated fixture process must start");
    writeFixture(launcherPid, `${String(unrelatedProcess.pid)}\n`);

    const { stop } = await import("./local-pipeline.mjs?unowned-launcher-stop-test");
    await expect(stop("production")).rejects.toThrow(
      /does not own the selected production runtime/,
    );

    assert.doesNotThrow(
      () => process.kill(unrelatedProcess.pid, 0),
      "an unrelated live process must not be signaled",
    );
    assert.equal(
      existsSync(launcherPid),
      true,
      "the rejected pid record must remain for diagnosis",
    );
    assert.equal(existsSync(operationLock), false, "the operation lock must still be released");
  } finally {
    unrelatedProcess.kill("SIGTERM");
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("fails stop when the tracked runtime exited but its backend survived", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-orphaned-backend-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;
  const backend = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    writeFixture(join(productionRoot, "electron.pid"), "2147483647\n");
    writeFixture(
      join(productionRoot, "home", "userdata", "server-runtime.json"),
      `${JSON.stringify({ pid: backend.pid })}\n`,
    );

    const { stop } = await import("./local-pipeline.mjs?orphaned-backend-test");
    await expect(stop("production")).rejects.toThrow(
      `runtime pid 2147483647 exited while backend pid ${String(backend.pid)} survived`,
    );
    assert.doesNotThrow(() => process.kill(backend.pid, 0));
    assert.equal(existsSync(join(productionRoot, "electron.pid")), true);
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    backend.kill("SIGKILL");
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("fails stop when runtime ownership is missing or invalid but its backend survived", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "t3-gocd-untracked-backend-"));
  const runtimeRoot = join(sandbox, "runtime");
  const artifactRoot = join(sandbox, "artifact");
  const productionRoot = join(runtimeRoot, "production");
  const runtimePidPath = join(productionRoot, "electron.pid");
  const previousRuntimeRoot = process.env.T3_PIPELINE_RUNTIME_ROOT;
  const previousArtifactRoot = process.env.T3_PIPELINE_ARTIFACT_ROOT;
  const backend = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });

  try {
    process.env.T3_PIPELINE_RUNTIME_ROOT = runtimeRoot;
    process.env.T3_PIPELINE_ARTIFACT_ROOT = artifactRoot;
    writeFixture(
      join(productionRoot, "home", "userdata", "server-runtime.json"),
      `${JSON.stringify({ pid: backend.pid })}\n`,
    );
    const { stop } = await import("./local-pipeline.mjs?untracked-backend-test");

    await expect(stop("production")).rejects.toThrow(
      `has no valid runtime pid while backend pid ${String(backend.pid)} survived`,
    );
    writeFixture(runtimePidPath, "not-a-pid\n");
    await expect(stop("production")).rejects.toThrow(
      `has no valid runtime pid while backend pid ${String(backend.pid)} survived`,
    );
    assert.doesNotThrow(() => process.kill(backend.pid, 0));
    assert.equal(readFileSync(runtimePidPath, "utf8"), "not-a-pid\n");
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.T3_PIPELINE_RUNTIME_ROOT;
    else process.env.T3_PIPELINE_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousArtifactRoot === undefined) delete process.env.T3_PIPELINE_ARTIFACT_ROOT;
    else process.env.T3_PIPELINE_ARTIFACT_ROOT = previousArtifactRoot;
    backend.kill("SIGKILL");
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("recovers an interrupted deploy transaction before starting the next deploy", async () => {
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

    const { deploy } = await import("./local-pipeline.mjs?interrupted-deploy-recovery-test");
    const launches = [];
    const verifications = [];
    await deploy("production", {
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
