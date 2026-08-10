#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { verifyProduction } from "./verify-production.mjs";

const { spawn, spawnSync } = NodeChildProcess;
const { randomUUID } = NodeCrypto;
const {
  cpSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = NodeFS;
const { homedir, platform } = NodeOS;
const { join, resolve } = NodePath;
const { pathToFileURL } = NodeURL;

const [command, environment = ""] = process.argv.slice(2);
const root = resolve(import.meta.dirname, "../..");
const runtimeRoot = resolve(process.env.T3_PIPELINE_RUNTIME_ROOT ?? join(homedir(), "t3-runtime"));
const artifactRoot = resolve(
  process.env.T3_PIPELINE_ARTIFACT_ROOT ?? join(root, "build", "pipeline-artifact"),
);
const productionRepository = "https://github.com/cheruvian/t3code.git";
const productionBranch = "main";
const environmentConfig = {
  staging: { port: 17773 },
  production: { port: 17774 },
};

function fail(message) {
  throw new Error(message);
}

function run(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    ...options,
  });
  if (result.status !== 0)
    fail(`${commandName} ${args.join(" ")} failed with status ${String(result.status)}`);
}

function environmentPaths(name) {
  const config = environmentConfig[name];
  if (!config) fail(`Unknown environment '${name}'. Expected staging or production.`);
  const base = join(runtimeRoot, name);
  return {
    base,
    home: join(base, "home"),
    releases: join(base, "releases"),
    current: join(base, "current"),
    previous: join(base, "previous"),
    operationLock: join(base, "operation.lock"),
    operationTransaction: join(base, "operation-transaction.json"),
    manualIntervention: join(base, "manual-intervention-required.json"),
    pid: join(base, "electron.pid"),
    log: join(base, "electron.log"),
    port: config.port,
  };
}

function desktopRuntimePaths(release) {
  const root = join(release, "apps", "desktop");
  const electronDist = join(root, "node_modules", "electron", "dist");
  return {
    root,
    launcher: join(root, "scripts", "start-electron.mjs"),
    electronPackage: join(root, "node_modules", "electron", "package.json"),
    electronExecutable:
      platform() === "darwin"
        ? join(electronDist, "Electron.app", "Contents", "MacOS", "Electron")
        : join(electronDist, platform() === "win32" ? "electron.exe" : "electron"),
    mainEntry: join(root, "dist-electron", "main.cjs"),
    serverEntry: join(release, "apps", "server", "dist", "bin.mjs"),
    manifest: join(release, "manifest.json"),
    candidateIcon: join(release, "assets", "dev", "blueprint-macos-1024.png"),
    productionIcon: join(release, "assets", "prod", "black-macos-1024.png"),
  };
}

function hasCompleteReleaseRuntime(release) {
  const runtime = desktopRuntimePaths(release);
  return Object.values(runtime).every(existsSync);
}

export function launchRelease(name, paths, release, commitHash, { spawnProcess = spawn } = {}) {
  const runtime = desktopRuntimePaths(release);
  if (!hasCompleteReleaseRuntime(release)) {
    throw new Error(`Release ${release} is missing its self-contained desktop runtime.`);
  }
  const stageLabel = name === "staging" ? "candidate" : "production";
  mkdirSync(paths.base, { recursive: true });
  const logFd = openSync(paths.log, "a");
  const childEnv = {
    ...process.env,
    T3CODE_HOME: paths.home,
    T3CODE_PORT: String(paths.port),
    T3CODE_COMMIT_HASH: commitHash,
    T3CODE_DESKTOP_APP_USER_MODEL_ID: `com.t3tools.t3code.${stageLabel}`,
    T3CODE_DESKTOP_STAGE_LABEL: stageLabel === "candidate" ? "Candidate" : "Production",
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawnProcess(runtime.electronExecutable, [runtime.mainEntry], {
    cwd: release,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: childEnv,
  });
  child.unref();
  closeSync(logFd);
  writeFileSync(paths.pid, `${child.pid}\n`);
}

function readPid(paths) {
  if (!existsSync(paths.pid)) return undefined;
  const serializedPid = readFileSync(paths.pid, "utf8").trim();
  if (!/^[1-9]\d*$/.test(serializedPid)) return undefined;
  const pid = Number(serializedPid);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function readBackendRuntimePid(paths) {
  const runtimeState = join(paths.home, "userdata", "server-runtime.json");
  if (!existsSync(runtimeState)) return undefined;
  try {
    const pid = JSON.parse(readFileSync(runtimeState, "utf8")).pid;
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireOperationLock(name, operation) {
  const paths = environmentPaths(name);
  mkdirSync(paths.base, { recursive: true });
  const token = randomUUID();
  const owner = {
    pid: process.pid,
    token,
    operation,
    startedAt: new Date().toISOString(),
  };
  const preparedOwner = `${paths.operationLock}.owner-${token}`;
  writeFileSync(preparedOwner, `${JSON.stringify(owner)}\n`);
  try {
    for (;;) {
      try {
        linkSync(preparedOwner, paths.operationLock);
        break;
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
          throw error;
        }
      }

      if (statSync(paths.operationLock).isDirectory()) {
        const legacyOwnerPath = join(paths.operationLock, "owner.json");
        let legacyOwner;
        try {
          legacyOwner = JSON.parse(readFileSync(legacyOwnerPath, "utf8"));
        } catch (ownerError) {
          throw new Error(
            `${name} operation lock at ${paths.operationLock} has no readable owner; refusing ${operation}.`,
            { cause: ownerError },
          );
        }
        if (
          !Number.isInteger(legacyOwner.pid) ||
          legacyOwner.pid <= 0 ||
          isAlive(legacyOwner.pid)
        ) {
          throw new Error(
            `${name} operation lock is already held at ${paths.operationLock}; refusing ${operation}.`,
          );
        }
        rmSync(paths.operationLock, { recursive: true, force: true });
        continue;
      }

      const staleClaim = `${paths.operationLock}.stale-${token}`;
      try {
        linkSync(paths.operationLock, staleClaim);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      try {
        const staleOwner = JSON.parse(readFileSync(staleClaim, "utf8"));
        if (!Number.isInteger(staleOwner.pid) || staleOwner.pid <= 0 || isAlive(staleOwner.pid)) {
          throw new Error(
            `${name} operation lock is already held at ${paths.operationLock}; refusing ${operation}.`,
          );
        }
        const claimed = statSync(staleClaim);
        let locked;
        try {
          locked = statSync(paths.operationLock);
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
            continue;
          }
          throw error;
        }
        if (claimed.dev === locked.dev && claimed.ino === locked.ino) {
          console.log(
            `[t3-pipeline] reclaiming ${name} operation lock from dead pid ${String(staleOwner.pid)}`,
          );
          unlinkSync(paths.operationLock);
        }
      } finally {
        rmSync(staleClaim, { force: true });
      }
    }
  } finally {
    rmSync(preparedOwner, { force: true });
  }
  return () => {
    const selectedOwner = JSON.parse(readFileSync(paths.operationLock, "utf8"));
    if (selectedOwner.token !== token || selectedOwner.pid !== process.pid) {
      throw new Error(`${name} operation lock ownership changed before release.`);
    }
    unlinkSync(paths.operationLock);
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function clearManualIntervention(paths) {
  rmSync(paths.manualIntervention, { force: true });
}

let pointerUpdateSequence = 0;
function replaceReleasePointer(pointer, release) {
  const replacement = `${pointer}.next-${process.pid}-${String(pointerUpdateSequence++)}`;
  try {
    symlinkSync(release, replacement);
    renameSync(replacement, pointer);
  } finally {
    rmSync(replacement, { force: true });
  }
}

function clearReleasePointer(pointer) {
  rmSync(pointer, { force: true });
}

function releaseManifestSha(release) {
  if (!release) return null;
  const manifestPath = join(release, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const sha = JSON.parse(readFileSync(manifestPath, "utf8")).sha;
    return /^[0-9a-f]{40}$/.test(sha ?? "") ? sha : null;
  } catch {
    return null;
  }
}

let transactionWriteSequence = 0;
function writeJsonAtomically(path, value) {
  const replacement = `${path}.next-${process.pid}-${String(transactionWriteSequence++)}`;
  try {
    writeFileSync(replacement, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(replacement, path);
  } finally {
    rmSync(replacement, { force: true });
  }
}

function beginOperationTransaction(paths, operation, current, previous) {
  const launcherPid = readPid(paths);
  writeJsonAtomically(paths.operationTransaction, {
    version: 1,
    operation,
    current: current ?? null,
    previous: previous ?? null,
    currentSha: releaseManifestSha(current),
    wasRunning: launcherPid !== undefined && isAlive(launcherPid),
    startedAt: new Date().toISOString(),
  });
}

function clearOperationTransaction(paths) {
  rmSync(paths.operationTransaction, { force: true });
}

function readOperationTransaction(paths) {
  if (!existsSync(paths.operationTransaction)) return undefined;
  let transaction;
  try {
    transaction = JSON.parse(readFileSync(paths.operationTransaction, "utf8"));
  } catch (error) {
    throw new Error(`Could not read interrupted operation at ${paths.operationTransaction}.`, {
      cause: error,
    });
  }
  const validPointer = (pointer) => pointer === null || typeof pointer === "string";
  if (
    transaction.version !== 1 ||
    typeof transaction.operation !== "string" ||
    !validPointer(transaction.current) ||
    !validPointer(transaction.previous) ||
    (transaction.currentSha !== null && !/^[0-9a-f]{40}$/.test(transaction.currentSha ?? "")) ||
    typeof transaction.wasRunning !== "boolean"
  ) {
    throw new Error(`Interrupted operation at ${paths.operationTransaction} is malformed.`);
  }
  return transaction;
}

function restoreReleaseSnapshot(paths, transaction) {
  clearReleasePointer(paths.current);
  clearReleasePointer(paths.previous);
  if (transaction.current) replaceReleasePointer(paths.current, transaction.current);
  if (transaction.previous) replaceReleasePointer(paths.previous, transaction.previous);
}

function compoundRecoveryFailure(paths, operation, initiatingError, recoveryError) {
  writeFileSync(
    paths.manualIntervention,
    `${JSON.stringify(
      {
        status: "manual-intervention-required",
        operation,
        recordedAt: new Date().toISOString(),
        initiatingError: errorMessage(initiatingError),
        recoveryError: errorMessage(recoveryError),
      },
      null,
      2,
    )}\n`,
  );
  return new AggregateError(
    [initiatingError, recoveryError],
    `${nameForError(paths)} ${operation} failed and recovery also failed. Manual intervention is required.`,
  );
}

function nameForError(paths) {
  return paths.base.split("/").at(-1) ?? "environment";
}

async function recoverInterruptedOperation(
  name,
  { launch = launchRelease, waitUntilReady = waitForServer, verify } = {},
) {
  const paths = environmentPaths(name);
  const transaction = readOperationTransaction(paths);
  if (!transaction) return;
  const interruptionError = new Error(
    `Detected an interrupted ${name} ${transaction.operation} transaction.`,
  );
  const rejectedRuntimePid = readBackendRuntimePid(paths);
  try {
    stopUnlocked(name, paths);
    restoreReleaseSnapshot(paths, transaction);
    if (transaction.wasRunning) {
      if (!transaction.current || !hasCompleteReleaseRuntime(transaction.current)) {
        throw new Error(`The interrupted ${name} release cannot be relaunched automatically.`);
      }
      const currentSha = releaseManifestSha(transaction.current);
      if (!transaction.currentSha || currentSha !== transaction.currentSha) {
        throw new Error(
          `The interrupted ${name} release manifest no longer matches its transaction snapshot.`,
        );
      }
      const verifySelectedRelease =
        verify ?? (name === "production" ? verifyProduction : async () => undefined);
      const launchedAfter = Date.now();
      launch(name, paths, transaction.current, transaction.currentSha);
      await waitUntilReady(paths.port);
      await verifySelectedRelease({
        runtimeRoot,
        port: paths.port,
        expectedRelease: transaction.current,
        expectedSha: transaction.currentSha,
        previousRuntimePid: rejectedRuntimePid,
        launchedAfter,
      });
    }
    clearOperationTransaction(paths);
    clearManualIntervention(paths);
    console.log(`[t3-pipeline] recovered interrupted ${name} ${transaction.operation}`);
  } catch (recoveryError) {
    throw compoundRecoveryFailure(
      paths,
      `interrupted-${transaction.operation}`,
      interruptionError,
      recoveryError,
    );
  }
}

function inspectManagedProcess(pid) {
  if (platform() !== "darwin") {
    throw new Error("Local pipeline process ownership checks currently require macOS.");
  }
  const processResult = spawnSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "ppid=,command="], {
    encoding: "utf8",
  });
  const match =
    processResult.status === 0 ? processResult.stdout.trim().match(/^(\d+)\s+(.+)$/s) : null;
  if (!match) throw new Error(`Could not inspect managed process ${String(pid)}.`);
  const cwdResult = spawnSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    encoding: "utf8",
  });
  const cwd =
    cwdResult.status === 0
      ? cwdResult.stdout
          .split("\n")
          .find((line) => line.startsWith("n"))
          ?.slice(1)
      : undefined;
  if (!cwd) throw new Error(`Could not inspect the working directory for process ${String(pid)}.`);
  return { pid, ppid: Number.parseInt(match[1], 10), command: match[2], cwd };
}

function processOwnsListener(pid, port) {
  const result = spawnSync(
    "/usr/sbin/lsof",
    ["-nP", "-a", "-p", String(pid), `-iTCP:${String(port)}`, "-sTCP:LISTEN", "-Fp"],
    { encoding: "utf8" },
  );
  return result.status === 0 && result.stdout.split("\n").includes(`p${String(pid)}`);
}

function processDescendsFrom(pid, ancestorPid) {
  let inspected = inspectManagedProcess(pid);
  for (let depth = 0; depth < 8 && inspected.ppid > 0; depth += 1) {
    if (inspected.ppid === ancestorPid) return true;
    inspected = inspectManagedProcess(inspected.ppid);
  }
  return false;
}

function assertManagedLauncher(name, paths, pid) {
  const launcher = inspectManagedProcess(pid);
  let selectedRelease;
  try {
    selectedRelease = existsSync(paths.current) ? realpathSync(paths.current) : undefined;
  } catch {
    selectedRelease = undefined;
  }
  if (selectedRelease) {
    const runtime = desktopRuntimePaths(selectedRelease);
    if (
      launcher.cwd === selectedRelease &&
      (launcher.command.includes(runtime.launcher) ||
        (launcher.command.includes(runtime.electronExecutable) &&
          launcher.command.includes(runtime.mainEntry)))
    ) {
      return launcher;
    }
  }

  const backendPid = readBackendRuntimePid(paths);
  if (backendPid !== undefined) {
    const backend = inspectManagedProcess(backendPid);
    if (
      backend.command.includes("/apps/server/dist/bin.mjs") &&
      processOwnsListener(backendPid, paths.port) &&
      processDescendsFrom(backendPid, pid)
    ) {
      return launcher;
    }
  }
  throw new Error(
    `Refusing to stop pid ${String(pid)} because it does not own the selected ${name} runtime.`,
  );
}

function waitForProcessExit(pid, deadline) {
  while (isAlive(pid) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return !isAlive(pid);
}

function stopUnlocked(name, paths = environmentPaths(name)) {
  const pid = readPid(paths);
  const backendPid = readBackendRuntimePid(paths);
  if (pid === undefined) {
    if (backendPid !== undefined && isAlive(backendPid)) {
      throw new Error(
        `${nameForError(paths)} has no valid runtime pid while backend pid ${String(backendPid)} survived.`,
      );
    }
    return;
  }
  if (!isAlive(pid) && backendPid !== undefined && isAlive(backendPid)) {
    throw new Error(
      `${nameForError(paths)} runtime pid ${String(pid)} exited while backend pid ${String(backendPid)} survived.`,
    );
  }
  if (isAlive(pid)) {
    const launcher = assertManagedLauncher(name, paths, pid);
    console.log(`[t3-pipeline] stopping ${name} server pid ${pid}`);
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 15_000;
    if (!waitForProcessExit(pid, deadline)) {
      const selectedLauncher = assertManagedLauncher(name, paths, pid);
      if (selectedLauncher.command !== launcher.command || selectedLauncher.cwd !== launcher.cwd) {
        throw new Error(`Refusing to kill reused ${name} launcher pid ${String(pid)}.`);
      }
      process.kill(pid, "SIGKILL");
      if (!waitForProcessExit(pid, Date.now() + 5_000)) {
        throw new Error(`${nameForError(paths)} runtime pid ${String(pid)} survived SIGKILL.`);
      }
    }
    if (backendPid !== undefined && !waitForProcessExit(backendPid, Date.now() + 5_000)) {
      throw new Error(
        `${nameForError(paths)} backend pid ${String(backendPid)} survived runtime shutdown.`,
      );
    }
  }
  unlinkSync(paths.pid);
}

export async function stop(name, options = {}) {
  const releaseLock = acquireOperationLock(name, "stop");
  try {
    await recoverInterruptedOperation(name, options);
    stopUnlocked(name);
  } finally {
    releaseLock();
  }
}

function waitForServer(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = spawnSync(
      "curl",
      ["--fail", "--silent", "--show-error", "--max-time", "2", `http://127.0.0.1:${port}/`],
      { stdio: "ignore" },
    );
    if (response.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(`T3 server did not become ready on port ${port}.`);
}

function resolveProductionHead() {
  const ref = `refs/heads/${productionBranch}`;
  const result = spawnSync("git", ["ls-remote", "--exit-code", productionRepository, ref], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Could not resolve ${productionRepository} ${ref}.`);
  }
  const [sha, resolvedRef, ...extra] = result.stdout.trim().split(/\s+/);
  if (!/^[0-9a-f]{40}$/.test(sha ?? "") || resolvedRef !== ref || extra.length > 0) {
    throw new Error(`Received a malformed head for ${productionRepository} ${ref}.`);
  }
  return sha;
}

async function build() {
  rmSync(artifactRoot, { recursive: true, force: true });
  mkdirSync(artifactRoot, { recursive: true });
  run("vp", ["run", "build"]);
  run("vp", ["run", "build:desktop"]);
  cpSync(join(root, "apps/server/dist"), join(artifactRoot, "dist"), { recursive: true });
  cpSync(join(root, "apps/desktop/dist-electron"), join(artifactRoot, "desktop-dist-electron"), {
    recursive: true,
  });
  const sha = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim();
  writeFileSync(join(artifactRoot, "manifest.json"), `${JSON.stringify({ sha }, null, 2)}\n`);
  console.log(`[t3-pipeline] built ${sha}`);
}

async function deployUnlocked(
  name,
  {
    launch = launchRelease,
    waitUntilReady = waitForServer,
    resolveTrackedHead = resolveProductionHead,
    verify,
  } = {},
) {
  const paths = environmentPaths(name);
  const manifestPath = join(artifactRoot, "manifest.json");
  if (!existsSync(manifestPath)) fail(`Missing ${manifestPath}; run the build stage first.`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!/^[0-9a-f]{40}$/.test(manifest.sha ?? "")) {
    fail(`Artifact manifest ${manifestPath} does not contain a valid 40-character SHA.`);
  }
  const assertTrackedProductionHead = async () => {
    if (name !== "production") return;
    const trackedHead = await resolveTrackedHead();
    if (manifest.sha !== trackedHead) {
      throw new Error(
        `Refusing to deploy production artifact ${String(manifest.sha)}; fork main is ${String(trackedHead)}.`,
      );
    }
  };
  await assertTrackedProductionHead();
  const release = join(paths.releases, manifest.sha);
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.releases, { recursive: true });
  const current = existsSync(paths.current) ? realpathSync(paths.current) : undefined;
  const previous = existsSync(paths.previous) ? realpathSync(paths.previous) : undefined;
  let transactionStarted = false;
  if (!hasCompleteReleaseRuntime(release)) {
    if (current === release) {
      beginOperationTransaction(paths, "deploy", current, previous);
      transactionStarted = true;
      stopUnlocked(name);
    }
    rmSync(release, { recursive: true, force: true });
    run("pnpm", ["deploy", "--legacy", "--filter", "t3", "--prod", release]);
    mkdirSync(join(release, "apps", "server"), { recursive: true });
    symlinkSync("../../dist", join(release, "apps", "server", "dist"));
    cpSync(join(root, "assets"), join(release, "assets"), { recursive: true });
    run("pnpm", [
      "deploy",
      "--legacy",
      "--filter",
      "@t3tools/desktop",
      "--prod",
      join(release, "apps", "desktop"),
    ]);
    cpSync(join(artifactRoot, "dist"), join(release, "dist"), { recursive: true });
    cpSync(
      join(artifactRoot, "desktop-dist-electron"),
      join(release, "apps", "desktop", "dist-electron"),
      {
        recursive: true,
      },
    );
    cpSync(manifestPath, join(release, "manifest.json"));
  }

  await assertTrackedProductionHead();

  const verifySelectedRelease =
    verify ?? (name === "production" ? verifyProduction : async () => undefined);
  if (!transactionStarted) beginOperationTransaction(paths, "deploy", current, previous);
  const previousRuntimePid = readBackendRuntimePid(paths);
  stopUnlocked(name);
  replaceReleasePointer(paths.current, release);

  try {
    const launchedAfter = Date.now();
    launch(name, paths, release, manifest.sha);
    await waitUntilReady(paths.port);
    await verifySelectedRelease({
      runtimeRoot,
      port: paths.port,
      expectedRelease: release,
      expectedSha: manifest.sha,
      previousRuntimePid,
      launchedAfter,
    });
    const selectedRelease = realpathSync(release);
    if (!current || !hasCompleteReleaseRuntime(current)) {
      clearReleasePointer(paths.previous);
    } else if (current !== selectedRelease) {
      replaceReleasePointer(paths.previous, current);
    }
    clearManualIntervention(paths);
    clearOperationTransaction(paths);
  } catch (error) {
    const rejectedRuntimePid = readBackendRuntimePid(paths);
    try {
      stopUnlocked(name);
      clearReleasePointer(paths.current);
      if (previous) replaceReleasePointer(paths.previous, previous);
      else clearReleasePointer(paths.previous);
      if (!current || !hasCompleteReleaseRuntime(current)) {
        if (current) replaceReleasePointer(paths.current, current);
        throw new Error(`The prior ${name} release cannot be relaunched automatically.`, {
          cause: error,
        });
      }
      replaceReleasePointer(paths.current, current);
      const previousManifest = join(current, "manifest.json");
      const previousHash = JSON.parse(readFileSync(previousManifest, "utf8")).sha;
      const launchedAfter = Date.now();
      launch(name, paths, current, previousHash);
      await waitUntilReady(paths.port);
      await verifySelectedRelease({
        runtimeRoot,
        port: paths.port,
        expectedRelease: current,
        expectedSha: previousHash,
        previousRuntimePid: rejectedRuntimePid,
        launchedAfter,
      });
      clearManualIntervention(paths);
      clearOperationTransaction(paths);
    } catch (recoveryError) {
      throw compoundRecoveryFailure(paths, "deploy", error, recoveryError);
    }
    throw error;
  }
  console.log(`[t3-pipeline] ${name} is running at http://127.0.0.1:${paths.port}`);
}

export async function deploy(name, options = {}) {
  const releaseLock = acquireOperationLock(name, "deploy");
  try {
    await recoverInterruptedOperation(name, options);
    return await deployUnlocked(name, options);
  } finally {
    releaseLock();
  }
}

async function status(name) {
  const paths = environmentPaths(name);
  const pid = readPid(paths);
  let manualIntervention = null;
  if (existsSync(paths.manualIntervention)) {
    try {
      manualIntervention = JSON.parse(readFileSync(paths.manualIntervention, "utf8"));
    } catch {
      manualIntervention = { status: "manual-intervention-required", details: "unreadable" };
    }
  }
  console.log(
    JSON.stringify(
      {
        environment: name,
        port: paths.port,
        home: paths.home,
        current: existsSync(paths.current) ? realpathSync(paths.current) : null,
        previous: existsSync(paths.previous) ? realpathSync(paths.previous) : null,
        pid: pid ?? null,
        running: pid === undefined ? false : isAlive(pid),
        manualIntervention,
      },
      null,
      2,
    ),
  );
}

async function startUnlocked(
  name,
  { launch = launchRelease, waitUntilReady = waitForServer, verify } = {},
) {
  const paths = environmentPaths(name);
  if (!existsSync(paths.current)) fail(`No current ${name} release is available.`);
  const release = realpathSync(paths.current);
  const manifestPath = join(release, "manifest.json");
  const commitHash = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8")).sha
    : "unknown";
  if (!hasCompleteReleaseRuntime(release)) {
    fail(`Current release ${release} is missing its self-contained desktop runtime.`);
  }
  const verifySelectedRelease =
    verify ?? (name === "production" ? verifyProduction : async () => undefined);
  const previousRuntimePid = readBackendRuntimePid(paths);
  stopUnlocked(name, paths);
  const launchedAfter = Date.now();
  launch(name, paths, release, commitHash);
  await waitUntilReady(paths.port);
  await verifySelectedRelease({
    runtimeRoot,
    port: paths.port,
    expectedRelease: release,
    expectedSha: commitHash,
    previousRuntimePid,
    launchedAfter,
  });
  clearManualIntervention(paths);
  console.log(`[t3-pipeline] ${name} started from ${release}`);
}

export async function start(name, options = {}) {
  const releaseLock = acquireOperationLock(name, "start");
  try {
    await recoverInterruptedOperation(name, options);
    return await startUnlocked(name, options);
  } finally {
    releaseLock();
  }
}

async function rollbackUnlocked(
  name,
  { launch = launchRelease, waitUntilReady = waitForServer, verify } = {},
) {
  const paths = environmentPaths(name);
  if (!existsSync(paths.current)) fail(`No current ${name} release is available.`);
  if (!existsSync(paths.previous)) fail(`No previous ${name} release is available.`);
  const current = realpathSync(paths.current);
  const previous = realpathSync(paths.previous);
  if (current === previous) fail(`Current and previous ${name} releases are identical.`);
  if (!hasCompleteReleaseRuntime(current)) {
    fail(`Current release ${current} is missing its self-contained desktop runtime.`);
  }
  if (!hasCompleteReleaseRuntime(previous)) {
    fail(`Previous release ${previous} is missing its self-contained desktop runtime.`);
  }
  const verifySelectedRelease =
    verify ?? (name === "production" ? verifyProduction : async () => undefined);
  beginOperationTransaction(paths, "rollback", current, previous);
  const previousRuntimePid = readBackendRuntimePid(paths);
  stopUnlocked(name, paths);
  replaceReleasePointer(paths.current, previous);
  replaceReleasePointer(paths.previous, current);
  const rollbackHash = existsSync(join(previous, "manifest.json"))
    ? JSON.parse(readFileSync(join(previous, "manifest.json"), "utf8")).sha
    : "unknown";
  try {
    const launchedAfter = Date.now();
    launch(name, paths, previous, rollbackHash);
    await waitUntilReady(paths.port);
    await verifySelectedRelease({
      runtimeRoot,
      port: paths.port,
      expectedRelease: previous,
      expectedSha: rollbackHash,
      previousRuntimePid,
      launchedAfter,
    });
    clearManualIntervention(paths);
    clearOperationTransaction(paths);
  } catch (error) {
    const rejectedRuntimePid = readBackendRuntimePid(paths);
    try {
      stopUnlocked(name, paths);
      replaceReleasePointer(paths.current, current);
      replaceReleasePointer(paths.previous, previous);
      const currentManifest = join(current, "manifest.json");
      const currentHash = JSON.parse(readFileSync(currentManifest, "utf8")).sha;
      const launchedAfter = Date.now();
      launch(name, paths, current, currentHash);
      await waitUntilReady(paths.port);
      await verifySelectedRelease({
        runtimeRoot,
        port: paths.port,
        expectedRelease: current,
        expectedSha: currentHash,
        previousRuntimePid: rejectedRuntimePid,
        launchedAfter,
      });
      clearManualIntervention(paths);
      clearOperationTransaction(paths);
    } catch (recoveryError) {
      throw compoundRecoveryFailure(paths, "rollback", error, recoveryError);
    }
    throw error;
  }
  console.log(`[t3-pipeline] rolled ${name} back to ${previous}`);
}

export async function rollback(name, options = {}) {
  const releaseLock = acquireOperationLock(name, "rollback");
  try {
    await recoverInterruptedOperation(name, options);
    return await rollbackUnlocked(name, options);
  } finally {
    releaseLock();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (import.meta.url === entrypoint) {
  try {
    if (command === "build") await build();
    else if (command === "deploy") await deploy(environment);
    else if (command === "start") await start(environment);
    else if (command === "rollback") await rollback(environment);
    else if (command === "status") await status(environment);
    else if (command === "stop") await stop(environment);
    else
      fail(
        "Usage: local-pipeline.mjs <build|deploy|start|rollback|status|stop> [staging|production]",
      );
  } catch (error) {
    console.error(`[t3-pipeline] ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
