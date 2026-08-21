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
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = NodeFS;
const { homedir, platform } = NodeOS;
const { basename, join, resolve } = NodePath;
const { pathToFileURL } = NodeURL;

const [command, environment = ""] = process.argv.slice(2);
const root = resolve(import.meta.dirname, "../..");
const runtimeRoot = resolve(process.env.T3_PIPELINE_RUNTIME_ROOT ?? join(homedir(), "t3-runtime"));
const releaseRetention = Math.max(2, Number(process.env.T3_PIPELINE_RELEASE_RETENTION ?? 3));
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

/**
 * Deletes superseded release directories once a deploy has settled, keeping the
 * newest `retain` releases plus whatever `current` and `previous` still resolve
 * to. Rollback only ever reaches for those two pointers, so anything older is
 * unreferenced disk. Call this after the release pointers are final.
 */
function pruneReleases(paths, retain = releaseRetention) {
  if (!existsSync(paths.releases)) return [];
  const pinned = new Set(
    [paths.current, paths.previous]
      .filter((pointer) => existsSync(pointer))
      .map((pointer) => realpathSync(pointer)),
  );
  const releases = readdirSync(paths.releases, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[0-9a-f]{40}$/.test(entry.name))
    .map((entry) => {
      const path = join(paths.releases, entry.name);
      // Pointers are compared as realpaths, so candidates must be resolved too.
      return { path, resolved: realpathSync(path), modifiedAt: statSync(path).mtimeMs };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt);

  const removed = [];
  for (const [index, release] of releases.entries()) {
    if (index < retain || pinned.has(release.resolved)) continue;
    rmSync(release.path, { recursive: true, force: true });
    removed.push(release.path);
  }
  return removed;
}

/**
 * Chrome DevTools endpoint for the deployed desktop renderer, opt-in per
 * deployment via `T3_PIPELINE_DESKTOP_DEBUG_PORT`. Profiling a real deployment
 * (heap, GC, WebSocket frames) otherwise means rebuilding the release by hand.
 * Unset leaves the launch argv untouched, so ordinary deploys expose nothing.
 * Electron binds this to loopback only.
 */
function resolveDesktopDebugPort(environment) {
  const configured = environment.T3_PIPELINE_DESKTOP_DEBUG_PORT;
  if (configured === undefined || configured.trim() === "") return undefined;
  const port = Number(configured);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    fail(
      `T3_PIPELINE_DESKTOP_DEBUG_PORT must be an integer between 1024 and 65535; received '${configured}'.`,
    );
  }
  return port;
}

export function launchRelease(
  name,
  paths,
  release,
  commitHash,
  {
    spawnProcess = spawn,
    readBirthToken = readProcessBirthToken,
    writeLauncherRecord = writeJsonExclusively,
    terminateSpawnedRuntime = terminateSpawnedRuntimeAndWait,
  } = {},
) {
  const runtime = desktopRuntimePaths(release);
  if (!hasCompleteReleaseRuntime(release)) {
    throw new Error(`Release ${release} is missing its self-contained desktop runtime.`);
  }
  const stageLabel = name === "staging" ? "candidate" : "production";
  mkdirSync(paths.base, { recursive: true });
  if (existsSync(paths.pid)) {
    throw new Error(`Refusing to launch ${name} while ownership marker ${paths.pid} exists.`);
  }
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
  const debugPort = resolveDesktopDebugPort(childEnv);
  const launchArgs =
    debugPort === undefined
      ? [runtime.mainEntry]
      : [runtime.mainEntry, `--remote-debugging-port=${String(debugPort)}`];
  let child;
  try {
    child = spawnProcess(runtime.electronExecutable, launchArgs, {
      cwd: release,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: childEnv,
    });
    const processBirthToken = readBirthToken(child.pid);
    writeLauncherRecord(paths.pid, { version: 1, pid: child.pid, processBirthToken });
    child.unref();
  } catch (error) {
    try {
      if (child) terminateSpawnedRuntime(child, paths);
    } catch (cleanupError) {
      const failure = new AggregateError(
        [error, cleanupError],
        `Could not register or quiesce spawned ${name} runtime pid ${String(child?.pid)}.`,
      );
      failure.runtimeCleanupIncomplete = true;
      throw failure;
    }
    throw error;
  } finally {
    closeSync(logFd);
  }
}

function readLauncherMarker(paths) {
  let serialized;
  try {
    serialized = readFileSync(paths.pid, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing", pid: undefined };
    throw error;
  }
  const candidate = serialized.trim();
  if (/^[1-9]\d*$/.test(candidate)) {
    const pid = Number(candidate);
    return Number.isSafeInteger(pid)
      ? { kind: "legacy", pid, serialized }
      : { kind: "invalid", pid: undefined, serialized };
  }
  try {
    const record = JSON.parse(candidate);
    if (
      record?.version === 1 &&
      Number.isSafeInteger(record.pid) &&
      record.pid > 0 &&
      typeof record.processBirthToken === "string" &&
      record.processBirthToken.length > 0
    ) {
      return { kind: "versioned", pid: record.pid, record, serialized };
    }
    const pid = record && typeof record === "object" ? record.pid : undefined;
    return {
      kind: "invalid",
      pid: Number.isSafeInteger(pid) && pid > 0 ? pid : undefined,
      serialized,
    };
  } catch {
    return { kind: "invalid", pid: undefined, serialized };
  }
}

function readPid(paths) {
  return readLauncherMarker(paths).pid;
}

function readLauncherRecord(paths) {
  const marker = readLauncherMarker(paths);
  return marker.kind === "versioned" ? marker.record : undefined;
}

function readBackendRuntimeState(paths) {
  const runtimeState = join(paths.home, "userdata", "server-runtime.json");
  if (!existsSync(runtimeState)) return undefined;
  try {
    const state = JSON.parse(readFileSync(runtimeState, "utf8"));
    if (
      state?.version !== 1 ||
      !Number.isInteger(state.pid) ||
      state.pid <= 0 ||
      !Number.isInteger(state.port) ||
      state.port !== paths.port ||
      typeof state.origin !== "string" ||
      typeof state.startedAt !== "string" ||
      Number.isNaN(Date.parse(state.startedAt))
    ) {
      throw new Error(`Managed backend runtime state is malformed at ${runtimeState}.`);
    }
    return state;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Managed backend runtime state")) {
      throw error;
    }
    throw new Error(`Managed backend runtime state is malformed at ${runtimeState}.`, {
      cause: error,
    });
  }
}

function readBackendRuntimeIdentity(paths) {
  try {
    const state = readBackendRuntimeState(paths);
    return state ? { pid: state.pid, startedAt: state.startedAt } : undefined;
  } catch {
    return undefined;
  }
}

function readProcessState(pid) {
  const result = spawnSync("/bin/ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

/**
 * True while the pid still names a process that can run.
 *
 * `kill(pid, 0)` also succeeds for a zombie — a process that has exited but
 * whose parent has not reaped it. The pipeline spawns launchers detached and
 * `unref()`s them, which stops it waiting on them but leaves it their parent,
 * so a launcher it kills within the same run stays a zombie for as long as the
 * pipeline itself lives. Counting that as alive is what produced "launcher pid
 * N survived SIGKILL" for a process that had already exited. A zombie holds no
 * port and runs no code, so treat it as gone.
 */
export function isAlive(pid, { probeState = readProcessState } = {}) {
  try {
    process.kill(pid, 0);
    return !probeState(pid).startsWith("Z");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return false;
    }
    if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

function isProcessGroupAlive(processGroupId) {
  const result = spawnSync("/bin/ps", ["-axo", "pgid=,stat="], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Could not inspect spawned runtime process group ${String(processGroupId)}.`);
  }
  return result.stdout.split("\n").some((line) => {
    const match = line.trim().match(/^(\d+)\s+(\S+)$/);
    return match !== null && Number(match[1]) === processGroupId && !match[2].startsWith("Z");
  });
}

function waitForProcessGroupExit(processGroupId, timeout) {
  const deadline = Date.now() + timeout;
  while (isProcessGroupAlive(processGroupId) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return !isProcessGroupAlive(processGroupId);
}

function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return;
    throw error;
  }
}

function terminateSpawnedRuntimeAndWait(child, paths) {
  if (platform() !== "darwin") {
    throw new Error("Local pipeline launch cleanup currently requires macOS process groups.");
  }
  const processGroupId = child.pid;
  signalProcessGroup(processGroupId, "SIGTERM");
  if (!waitForProcessGroupExit(processGroupId, 5_000)) {
    signalProcessGroup(processGroupId, "SIGKILL");
    if (!waitForProcessGroupExit(processGroupId, 5_000)) {
      throw new Error(`Spawned runtime process group ${String(processGroupId)} survived SIGKILL.`);
    }
  }
  const listeners = listenerPids(paths.port);
  if (listeners.length > 0) {
    throw new Error(`Port ${String(paths.port)} remained occupied after spawned runtime cleanup.`);
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

function assertRecoveryMayProceed(paths, operation, error) {
  if (!error || typeof error !== "object" || error.runtimeCleanupIncomplete !== true) return;
  throw compoundRecoveryFailure(
    paths,
    operation,
    error,
    new Error("Automatic recovery was withheld because spawned runtime cleanup was incomplete."),
  );
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

function writeJsonExclusively(path, value) {
  const prepared = `${path}.next-${process.pid}-${String(transactionWriteSequence++)}`;
  try {
    writeFileSync(prepared, `${JSON.stringify(value, null, 2)}\n`);
    linkSync(prepared, path);
  } finally {
    rmSync(prepared, { force: true });
  }
}

function beginOperationTransaction(
  paths,
  operation,
  current,
  previous,
  processControl = defaultProcessControl,
) {
  const release = selectedRelease(paths);
  const wasRunning =
    release !== undefined &&
    (captureManagedLauncher(paths, release, processControl) !== undefined ||
      captureManagedBackend(paths, release, processControl) !== undefined);
  writeJsonAtomically(paths.operationTransaction, {
    version: 1,
    operation,
    current: current ?? null,
    previous: previous ?? null,
    currentSha: releaseManifestSha(current),
    wasRunning,
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
  {
    launch = launchRelease,
    waitUntilReady = waitForServer,
    verify,
    processControl = defaultProcessControl,
  } = {},
) {
  const paths = environmentPaths(name);
  const transaction = readOperationTransaction(paths);
  if (!transaction) return;
  const interruptionError = new Error(
    `Detected an interrupted ${name} ${transaction.operation} transaction.`,
  );
  const rejectedRuntimeIdentity = readBackendRuntimeIdentity(paths);
  try {
    stopUnlocked(name, paths, processControl);
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
      await waitUntilReady(
        { paths, expectedRelease: transaction.current, rejectedRuntimeIdentity, launchedAfter },
        processControl,
      );
      await verifySelectedRelease({
        runtimeRoot,
        port: paths.port,
        expectedRelease: transaction.current,
        expectedSha: transaction.currentSha,
        previousRuntimeIdentity: rejectedRuntimeIdentity,
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
  const processResult = spawnSync(
    "/bin/ps",
    ["-ww", "-p", String(pid), "-o", "ppid=,lstart=,command="],
    { encoding: "utf8" },
  );
  const match =
    processResult.status === 0
      ? processResult.stdout.trim().match(/^(\d+)\s+(.{24})\s+(.+)$/s)
      : null;
  if (!match) throw new Error(`Could not inspect managed process ${String(pid)}.`);
  const processBirthTime = Date.parse(match[2]);
  if (Number.isNaN(processBirthTime)) {
    throw new Error(`Could not inspect the birth time for process ${String(pid)}.`);
  }
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
  return {
    pid,
    ppid: Number.parseInt(match[1], 10),
    birthToken: new Date(processBirthTime).toISOString(),
    command: match[3],
    cwd,
  };
}

function readProcessBirthToken(pid) {
  if (platform() !== "darwin") {
    throw new Error("Local pipeline process ownership checks currently require macOS.");
  }
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
  });
  const processBirthTime = result.status === 0 ? Date.parse(result.stdout.trim()) : Number.NaN;
  if (Number.isNaN(processBirthTime)) {
    throw new Error(`Could not inspect the birth time for process ${String(pid)}.`);
  }
  return new Date(processBirthTime).toISOString();
}

export function parseListenerPids(result, port) {
  if (
    result.status === 1 &&
    String(result.stdout ?? "").trim() === "" &&
    String(result.stderr ?? "").trim() === ""
  ) {
    return [];
  }
  if (result.status !== 0) {
    throw new Error(`Could not inspect listeners on port ${String(port)}.`);
  }
  return [
    ...new Set(
      result.stdout
        .split("\n")
        .filter((line) => /^p[1-9]\d*$/.test(line))
        .map((line) => Number(line.slice(1))),
    ),
  ];
}

function listenerPids(port) {
  return parseListenerPids(
    spawnSync("/usr/sbin/lsof", ["-nP", `-iTCP:${String(port)}`, "-sTCP:LISTEN", "-Fp"], {
      encoding: "utf8",
    }),
    port,
  );
}

function selectedRelease(paths) {
  try {
    return existsSync(paths.current) ? realpathSync(paths.current) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Electron binaries inside the release's branded runtime bundles.
 *
 * On macOS the desktop app does not run the packaged Electron directly: it
 * runs a branded bundle that `apps/desktop/scripts/electron-launcher.mjs`
 * builds at `<desktop>/.electron-runtime/<Product>.app`, whose
 * `Contents/MacOS/Electron` is a *copy* of the packaged binary, not a symlink
 * to it. A backend launched that way is legitimately ours, so the identity
 * allowlist has to name it — otherwise the pipeline can never prove it owns a
 * running desktop backend and every deploy that must replace one fails.
 *
 * Only bundles inside the selected release count. Every path stays rooted at
 * the release's own `.electron-runtime`, so this cannot widen ownership to a
 * process from another release, another checkout, or a developer's dev server.
 * Non-darwin hosts launch the packaged binary directly and have no bundles.
 *
 * Derived here rather than added to `desktopRuntimePaths`, because
 * `hasCompleteReleaseRuntime` requires every path in that struct to exist and
 * the bundle is built lazily on first launch, not by the deploy.
 */
function brandedRuntimeExecutables(runtime) {
  if (platform() !== "darwin") return [];
  const brandedRuntimeDir = join(runtime.root, ".electron-runtime");
  let entries;
  try {
    entries = readdirSync(brandedRuntimeDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => join(brandedRuntimeDir, entry.name, "Contents", "MacOS", "Electron"))
    .filter((executable) => existsSync(executable));
}

function allowedElectronExecutables(runtime) {
  const executables = new Set([runtime.electronExecutable]);
  for (const executable of [runtime.electronExecutable, ...brandedRuntimeExecutables(runtime)]) {
    executables.add(executable);
    try {
      executables.add(realpathSync(executable));
    } catch {
      // A missing executable is rejected by the exact-command check below.
    }
  }
  return [...executables];
}

function launcherCommandMatches(processIdentity, release) {
  const runtime = desktopRuntimePaths(release);
  return allowedElectronExecutables(runtime).some(
    (executable) => processIdentity.command === `${executable} ${runtime.mainEntry}`,
  );
}

function backendCommandMatches(processIdentity, release) {
  const runtime = desktopRuntimePaths(release);
  return allowedElectronExecutables(runtime).some((executable) => {
    const prefix = `${executable} ${runtime.serverEntry} --bootstrap-fd `;
    return (
      processIdentity.command.startsWith(prefix) &&
      /^\d+$/.test(processIdentity.command.slice(prefix.length))
    );
  });
}

const defaultProcessControl = {
  now: Date.now,
  pause: (milliseconds) =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds),
  isAlive,
  inspectProcess: inspectManagedProcess,
  listenerPids,
  signal: (pid, signal) => process.kill(pid, signal),
  httpReady: (port) =>
    spawnSync(
      "curl",
      ["--fail", "--silent", "--show-error", "--max-time", "2", `http://127.0.0.1:${port}/`],
      { stdio: "ignore" },
    ).status === 0,
};

function sameProcessIdentity(expected, actual) {
  return (
    actual.pid === expected.pid &&
    actual.birthToken === expected.birthToken &&
    actual.command === expected.command &&
    actual.cwd === expected.cwd
  );
}

function processBirthMatchesRuntime(processIdentity, runtimeState) {
  const processBirthTime = Date.parse(processIdentity.birthToken);
  return !Number.isNaN(processBirthTime) && processBirthTime <= Date.parse(runtimeState.startedAt);
}

function waitForCondition(predicate, timeout, processControl) {
  const deadline = processControl.now() + timeout;
  while (!predicate() && processControl.now() < deadline) processControl.pause(100);
  return predicate();
}

function captureManagedBackend(paths, release, processControl) {
  const state = readBackendRuntimeState(paths);
  if (!state || !processControl.isAlive(state.pid)) return undefined;
  const backend = processControl.inspectProcess(state.pid);
  if (
    backend.cwd !== release ||
    !backendCommandMatches(backend, release) ||
    !processBirthMatchesRuntime(backend, state)
  ) {
    throw new Error(
      `Refusing to stop backend pid ${String(state.pid)} because its process identity does not match the selected runtime.`,
    );
  }
  const listeners = processControl.listenerPids(paths.port);
  if (listeners.length !== 1 || listeners[0] !== state.pid) {
    throw new Error(
      `Refusing to stop backend pid ${String(state.pid)} because it does not exclusively own port ${String(paths.port)}.`,
    );
  }
  return { process: backend, state };
}

function captureManagedLauncher(
  paths,
  release,
  processControl,
  marker = readLauncherMarker(paths),
) {
  const record = marker.kind === "versioned" ? marker.record : undefined;
  if (!record || !processControl.isAlive(record.pid)) return undefined;
  const launcher = processControl.inspectProcess(record.pid);
  if (
    launcher.birthToken !== record.processBirthToken ||
    launcher.cwd !== release ||
    !launcherCommandMatches(launcher, release)
  ) {
    return undefined;
  }
  return launcher;
}

function processDescendsFrom(processIdentity, ancestor, processControl) {
  let selected = processIdentity;
  const visited = new Set([selected.pid]);
  for (let depth = 0; depth < 16; depth += 1) {
    if (selected.ppid === ancestor.pid) {
      return Date.parse(ancestor.birthToken) <= Date.parse(selected.birthToken);
    }
    if (!Number.isInteger(selected.ppid) || selected.ppid <= 1 || visited.has(selected.ppid)) {
      return false;
    }
    visited.add(selected.ppid);
    const parent = processControl.inspectProcess(selected.ppid);
    if (Date.parse(parent.birthToken) > Date.parse(selected.birthToken)) return false;
    selected = parent;
  }
  return false;
}

/**
 * Command shape of a launcher spawned by the pre-versioned pipeline:
 * `node <release>/apps/desktop/scripts/start-electron.mjs`, which is what the
 * original `launchRelease` ran (`spawn(process.execPath, [runtime.launcher])`).
 * Current releases run Electron against `dist-electron/main.cjs` instead, but a
 * long-lived host still carries one of these under a legacy pid marker, and
 * `captureManagedLegacyLauncher` exists precisely to retire them — it could
 * never authenticate one while this shape went unrecognised.
 *
 * The Node binary lives outside the release (Homebrew, nvm, a system install)
 * so it cannot be pinned. Ownership rests on the release-rooted script path
 * plus the caller's other checks: the launcher must run from `release`, and it
 * must actually supervise the already-authenticated backend.
 */
function legacyLauncherCommandMatches(processIdentity, release) {
  const { launcher } = desktopRuntimePaths(release);
  const suffix = ` ${launcher}`;
  if (!processIdentity.command.endsWith(suffix)) return false;
  const executable = processIdentity.command.slice(0, -suffix.length);
  return executable.startsWith("/") || /^[A-Za-z]:[\\/]/.test(executable);
}

/**
 * Either launcher shape this pipeline can own: the Electron entry the current
 * `launchRelease` spawns, or the pre-versioned Node script. Capture and the
 * terminate-time re-validation must agree — authenticating a launcher and then
 * refusing to terminate it strands the environment mid-transaction and demands
 * manual intervention.
 */
function managedLauncherCommandMatches(processIdentity, release) {
  return (
    launcherCommandMatches(processIdentity, release) ||
    legacyLauncherCommandMatches(processIdentity, release)
  );
}

function captureManagedLegacyLauncher(paths, release, backend, processControl, marker) {
  if (marker.kind !== "legacy" || !processControl.isAlive(marker.pid)) return undefined;
  const launcher = processControl.inspectProcess(marker.pid);
  if (launcher.cwd !== release || !managedLauncherCommandMatches(launcher, release)) {
    throw new Error(
      `Refusing to stop legacy launcher pid ${String(marker.pid)} because its process identity does not match the selected runtime.`,
    );
  }
  if (!backend) {
    throw new Error(
      `Refusing to stop legacy launcher pid ${String(marker.pid)} without an authenticated backend.`,
    );
  }
  if (!processDescendsFrom(backend.process, launcher, processControl)) {
    throw new Error(
      `Refusing to stop legacy launcher pid ${String(marker.pid)} because it does not supervise the authenticated backend.`,
    );
  }
  return { process: launcher, record: marker };
}

function assertBackendStillOwned(paths, release, captured, processControl, phase) {
  const selected = processControl.inspectProcess(captured.process.pid);
  if (
    !sameProcessIdentity(captured.process, selected) ||
    !backendCommandMatches(selected, release)
  ) {
    throw new Error(`Refusing to ${phase} reused backend pid ${String(captured.process.pid)}.`);
  }
  let state;
  try {
    state = readBackendRuntimeState(paths);
  } catch (error) {
    throw new Error(`Refusing to ${phase} backend with changed runtime state.`, { cause: error });
  }
  const stateChanged =
    state &&
    (state.pid !== captured.state.pid ||
      state.startedAt !== captured.state.startedAt ||
      state.port !== captured.state.port ||
      state.origin !== captured.state.origin);
  if ((phase === "terminate" && !state) || stateChanged) {
    throw new Error(`Refusing to ${phase} backend with a different runtime generation.`);
  }
  const listeners = processControl.listenerPids(paths.port);
  const validListeners =
    phase === "terminate"
      ? listeners.length === 1 && listeners[0] === captured.process.pid
      : listeners.length === 0 || (listeners.length === 1 && listeners[0] === captured.process.pid);
  if (!validListeners) {
    throw new Error(`Refusing to ${phase} backend while port ownership is ambiguous.`);
  }
  return selected;
}

function assertLauncherStillOwned(paths, release, captured, processControl, phase) {
  const record = readLauncherRecord(paths);
  const selected = processControl.inspectProcess(captured.pid);
  if (
    record?.pid !== captured.pid ||
    record.processBirthToken !== captured.birthToken ||
    !sameProcessIdentity(captured, selected) ||
    !launcherCommandMatches(selected, release)
  ) {
    throw new Error(`Refusing to ${phase} reused launcher pid ${String(captured.pid)}.`);
  }
  return selected;
}

function assertLegacyLauncherStillOwned(paths, release, captured, backend, processControl, phase) {
  const launcher = processControl.inspectProcess(captured.process.pid);
  let marker;
  try {
    marker = readFileSync(paths.pid, "utf8");
  } catch {
    marker = undefined;
  }
  if (
    marker !== captured.record.serialized ||
    !sameProcessIdentity(captured.process, launcher) ||
    launcher.cwd !== release ||
    !managedLauncherCommandMatches(launcher, release)
  ) {
    throw new Error(`Refusing to ${phase} reused legacy launcher pid ${String(launcher.pid)}.`);
  }
  if (!processControl.isAlive(backend.process.pid)) {
    if (phase !== "kill" || processControl.listenerPids(paths.port).length > 0) {
      throw new Error(
        `Refusing to ${phase} legacy launcher pid ${String(launcher.pid)} after its backend identity changed.`,
      );
    }
    return launcher;
  }
  const selectedBackend = assertBackendStillOwned(paths, release, backend, processControl, phase);
  if (!processDescendsFrom(selectedBackend, launcher, processControl)) {
    throw new Error(
      `Refusing to ${phase} legacy launcher pid ${String(launcher.pid)} because it no longer supervises the authenticated backend.`,
    );
  }
  return launcher;
}

function stopUnlocked(
  name,
  paths = environmentPaths(name),
  processControl = defaultProcessControl,
) {
  const release = selectedRelease(paths);
  const launcherMarker = readLauncherMarker(paths);
  const recordedPid = launcherMarker.pid;
  const initialListeners = processControl.listenerPids(paths.port);
  if (!release) {
    if (initialListeners.length > 0) {
      throw new Error(`${nameForError(paths)} has no selected release while its port is occupied.`);
    }
    if (recordedPid === undefined || !processControl.isAlive(recordedPid)) {
      rmSync(paths.pid, { force: true });
    }
    return;
  }

  const backend = captureManagedBackend(paths, release, processControl);
  const launcher = captureManagedLauncher(paths, release, processControl, launcherMarker);
  const legacyLauncher = launcher
    ? undefined
    : captureManagedLegacyLauncher(paths, release, backend, processControl, launcherMarker);
  if (initialListeners.length > 0 && !backend) {
    throw new Error(
      `${nameForError(paths)} port ${String(paths.port)} is occupied by an unverified process.`,
    );
  }

  const launcherProcess = launcher ?? legacyLauncher?.process;
  if (launcherProcess) {
    if (legacyLauncher) {
      assertLegacyLauncherStillOwned(
        paths,
        release,
        legacyLauncher,
        backend,
        processControl,
        "terminate",
      );
    } else {
      assertLauncherStillOwned(paths, release, launcherProcess, processControl, "terminate");
    }
    console.log(`[t3-pipeline] stopping ${name} launcher pid ${String(launcherProcess.pid)}`);
    processControl.signal(launcherProcess.pid, "SIGTERM");
    waitForCondition(
      () =>
        !processControl.isAlive(launcherProcess.pid) &&
        (!backend || !processControl.isAlive(backend.process.pid)) &&
        processControl.listenerPids(paths.port).length === 0,
      15_000,
      processControl,
    );
    if (processControl.isAlive(launcherProcess.pid)) {
      if (legacyLauncher) {
        assertLegacyLauncherStillOwned(
          paths,
          release,
          legacyLauncher,
          backend,
          processControl,
          "kill",
        );
      } else {
        assertLauncherStillOwned(paths, release, launcherProcess, processControl, "kill");
      }
      processControl.signal(launcherProcess.pid, "SIGKILL");
      if (
        !waitForCondition(() => !processControl.isAlive(launcherProcess.pid), 5_000, processControl)
      ) {
        throw new Error(
          `${nameForError(paths)} launcher pid ${String(launcherProcess.pid)} survived SIGKILL.`,
        );
      }
    }
  }

  if (backend && processControl.isAlive(backend.process.pid)) {
    assertBackendStillOwned(paths, release, backend, processControl, "terminate");
    console.log(`[t3-pipeline] stopping ${name} backend pid ${String(backend.process.pid)}`);
    processControl.signal(backend.process.pid, "SIGTERM");
    if (
      !waitForCondition(() => !processControl.isAlive(backend.process.pid), 5_000, processControl)
    ) {
      assertBackendStillOwned(paths, release, backend, processControl, "kill");
      processControl.signal(backend.process.pid, "SIGKILL");
      if (
        !waitForCondition(() => !processControl.isAlive(backend.process.pid), 5_000, processControl)
      ) {
        throw new Error(
          `${nameForError(paths)} backend pid ${String(backend.process.pid)} survived SIGKILL.`,
        );
      }
    }
  }

  if (processControl.listenerPids(paths.port).length > 0) {
    throw new Error(
      `${nameForError(paths)} port ${String(paths.port)} remained occupied after shutdown.`,
    );
  }
  if (launcherProcess || recordedPid === undefined || !processControl.isAlive(recordedPid)) {
    rmSync(paths.pid, { force: true });
  }
}

export async function stop(name, options = {}) {
  const releaseLock = acquireOperationLock(name, "stop");
  try {
    await recoverInterruptedOperation(name, options);
    stopUnlocked(name, environmentPaths(name), options.processControl ?? defaultProcessControl);
  } finally {
    releaseLock();
  }
}

function runtimeStateMatches(left, right) {
  return (
    left.pid === right.pid &&
    left.startedAt === right.startedAt &&
    left.port === right.port &&
    left.origin === right.origin
  );
}

function isRejectedRuntime(state, rejectedRuntimeIdentity) {
  return (
    rejectedRuntimeIdentity !== undefined &&
    state.pid === rejectedRuntimeIdentity.pid &&
    state.startedAt === rejectedRuntimeIdentity.startedAt
  );
}

export async function waitForServer(
  { paths, expectedRelease, rejectedRuntimeIdentity, launchedAfter },
  processControl = defaultProcessControl,
) {
  const selectedExpectedRelease = realpathSync(expectedRelease);
  const deadline = processControl.now() + 30_000;
  while (processControl.now() < deadline) {
    try {
      const state = readBackendRuntimeState(paths);
      if (
        !state ||
        isRejectedRuntime(state, rejectedRuntimeIdentity) ||
        Date.parse(state.startedAt) < launchedAfter
      ) {
        processControl.pause(250);
        continue;
      }
      const backend = processControl.inspectProcess(state.pid);
      const listeners = processControl.listenerPids(paths.port);
      if (
        backend.cwd !== selectedExpectedRelease ||
        !backendCommandMatches(backend, selectedExpectedRelease) ||
        !processBirthMatchesRuntime(backend, state) ||
        listeners.length !== 1 ||
        listeners[0] !== state.pid
      ) {
        processControl.pause(250);
        continue;
      }
      if (!processControl.httpReady(paths.port)) {
        processControl.pause(250);
        continue;
      }
      const confirmedState = readBackendRuntimeState(paths);
      if (!confirmedState || !runtimeStateMatches(state, confirmedState)) {
        processControl.pause(250);
        continue;
      }
      const confirmedBackend = processControl.inspectProcess(state.pid);
      const confirmedListeners = processControl.listenerPids(paths.port);
      if (
        !sameProcessIdentity(backend, confirmedBackend) ||
        !backendCommandMatches(confirmedBackend, selectedExpectedRelease) ||
        confirmedListeners.length !== 1 ||
        confirmedListeners[0] !== state.pid
      ) {
        processControl.pause(250);
        continue;
      }
      return { pid: state.pid, startedAt: state.startedAt };
    } catch {
      processControl.pause(250);
    }
  }
  throw new Error(`T3 server did not become ready on port ${String(paths.port)}.`);
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
    processControl = defaultProcessControl,
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
      beginOperationTransaction(paths, "deploy", current, previous, processControl);
      transactionStarted = true;
      stopUnlocked(name, paths, processControl);
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
  if (!transactionStarted)
    beginOperationTransaction(paths, "deploy", current, previous, processControl);
  const previousRuntimeIdentity = readBackendRuntimeIdentity(paths);
  stopUnlocked(name, paths, processControl);
  replaceReleasePointer(paths.current, release);

  try {
    const launchedAfter = Date.now();
    launch(name, paths, release, manifest.sha);
    await waitUntilReady(
      {
        paths,
        expectedRelease: release,
        rejectedRuntimeIdentity: previousRuntimeIdentity,
        launchedAfter,
      },
      processControl,
    );
    await verifySelectedRelease({
      runtimeRoot,
      port: paths.port,
      expectedRelease: release,
      expectedSha: manifest.sha,
      previousRuntimeIdentity,
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
    for (const pruned of pruneReleases(paths)) {
      console.log(`[t3-pipeline] pruned superseded ${name} release ${basename(pruned)}`);
    }
  } catch (error) {
    assertRecoveryMayProceed(paths, "deploy", error);
    const rejectedRuntimeIdentity = readBackendRuntimeIdentity(paths);
    try {
      stopUnlocked(name, paths, processControl);
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
      await waitUntilReady(
        { paths, expectedRelease: current, rejectedRuntimeIdentity, launchedAfter },
        processControl,
      );
      await verifySelectedRelease({
        runtimeRoot,
        port: paths.port,
        expectedRelease: current,
        expectedSha: previousHash,
        previousRuntimeIdentity: rejectedRuntimeIdentity,
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
  {
    launch = launchRelease,
    waitUntilReady = waitForServer,
    verify,
    processControl = defaultProcessControl,
  } = {},
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
  const previousRuntimeIdentity = readBackendRuntimeIdentity(paths);
  stopUnlocked(name, paths, processControl);
  const launchedAfter = Date.now();
  launch(name, paths, release, commitHash);
  await waitUntilReady(
    {
      paths,
      expectedRelease: release,
      rejectedRuntimeIdentity: previousRuntimeIdentity,
      launchedAfter,
    },
    processControl,
  );
  await verifySelectedRelease({
    runtimeRoot,
    port: paths.port,
    expectedRelease: release,
    expectedSha: commitHash,
    previousRuntimeIdentity,
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
  {
    launch = launchRelease,
    waitUntilReady = waitForServer,
    verify,
    processControl = defaultProcessControl,
  } = {},
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
  beginOperationTransaction(paths, "rollback", current, previous, processControl);
  const previousRuntimeIdentity = readBackendRuntimeIdentity(paths);
  stopUnlocked(name, paths, processControl);
  replaceReleasePointer(paths.current, previous);
  replaceReleasePointer(paths.previous, current);
  const rollbackHash = existsSync(join(previous, "manifest.json"))
    ? JSON.parse(readFileSync(join(previous, "manifest.json"), "utf8")).sha
    : "unknown";
  try {
    const launchedAfter = Date.now();
    launch(name, paths, previous, rollbackHash);
    await waitUntilReady(
      {
        paths,
        expectedRelease: previous,
        rejectedRuntimeIdentity: previousRuntimeIdentity,
        launchedAfter,
      },
      processControl,
    );
    await verifySelectedRelease({
      runtimeRoot,
      port: paths.port,
      expectedRelease: previous,
      expectedSha: rollbackHash,
      previousRuntimeIdentity,
      launchedAfter,
    });
    clearManualIntervention(paths);
    clearOperationTransaction(paths);
  } catch (error) {
    assertRecoveryMayProceed(paths, "rollback", error);
    const rejectedRuntimeIdentity = readBackendRuntimeIdentity(paths);
    try {
      stopUnlocked(name, paths, processControl);
      replaceReleasePointer(paths.current, current);
      replaceReleasePointer(paths.previous, previous);
      const currentManifest = join(current, "manifest.json");
      const currentHash = JSON.parse(readFileSync(currentManifest, "utf8")).sha;
      const launchedAfter = Date.now();
      launch(name, paths, current, currentHash);
      await waitUntilReady(
        { paths, expectedRelease: current, rejectedRuntimeIdentity, launchedAfter },
        processControl,
      );
      await verifySelectedRelease({
        runtimeRoot,
        port: paths.port,
        expectedRelease: current,
        expectedSha: currentHash,
        previousRuntimeIdentity: rejectedRuntimeIdentity,
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
