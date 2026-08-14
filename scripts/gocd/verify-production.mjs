#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const { spawnSync } = NodeChildProcess;
const { existsSync, readFileSync, realpathSync } = NodeFS;
const { homedir, platform } = NodeOS;
const { join, resolve } = NodePath;
const { pathToFileURL } = NodeURL;

function inspectProductionProcess(pid, port) {
  if (platform() !== "darwin") {
    throw new Error(`Production process inspection is unsupported on ${platform()}.`);
  }
  const listener = spawnSync(
    "/usr/sbin/lsof",
    ["-nP", `-iTCP:${String(port)}`, "-sTCP:LISTEN", "-Fp"],
    { encoding: "utf8" },
  );
  const cwd = spawnSync("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    encoding: "utf8",
  });
  const command = spawnSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "lstart=,command="], {
    encoding: "utf8",
  });
  const cwdPath = cwd.stdout
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1);
  const commandMatch =
    command.status === 0 ? command.stdout.trim().match(/^(.{24})\s+(.+)$/s) : null;
  const birthTime = commandMatch ? Date.parse(commandMatch[1]) : Number.NaN;
  return {
    pid,
    alive: commandMatch !== null && !Number.isNaN(birthTime),
    birthToken: Number.isNaN(birthTime) ? undefined : new Date(birthTime).toISOString(),
    cwd: cwd.status === 0 && cwdPath ? cwdPath : undefined,
    command: commandMatch?.[2] ?? "",
    listenerPids:
      listener.status === 0
        ? [
            ...new Set(
              listener.stdout
                .split("\n")
                .filter((line) => /^p[1-9]\d*$/.test(line))
                .map((line) => Number(line.slice(1))),
            ),
          ]
        : [],
  };
}

function readRuntimeState(runtimeRoot) {
  const statePath = join(runtimeRoot, "production", "home", "userdata", "server-runtime.json");
  if (!existsSync(statePath)) throw new Error(`Production runtime state is missing ${statePath}.`);
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    throw new Error(`Production runtime state is malformed at ${statePath}.`, { cause: error });
  }
  if (
    state?.version !== 1 ||
    !Number.isInteger(state.pid) ||
    state.pid <= 0 ||
    !Number.isInteger(state.port) ||
    typeof state.origin !== "string" ||
    typeof state.startedAt !== "string" ||
    Number.isNaN(Date.parse(state.startedAt))
  ) {
    throw new Error(`Production runtime state is malformed at ${statePath}.`);
  }
  return state;
}

export async function verifyProduction({
  port = process.env.T3_PRODUCTION_PORT ?? "17774",
  runtimeRoot = resolve(process.env.T3_PIPELINE_RUNTIME_ROOT ?? join(homedir(), "t3-runtime")),
  expectedRelease,
  expectedSha = process.env.GO_TO_REVISION_T3CODE,
  previousRuntimeIdentity,
  launchedAfter,
  fetchImpl = globalThis.fetch,
  inspectProcess = inspectProductionProcess,
} = {}) {
  const numericPort = Number.parseInt(String(port), 10);
  if (!/^[0-9a-f]{40}$/.test(expectedSha ?? "")) {
    throw new Error(`Production verification requires an exact 40-character release SHA.`);
  }
  const current = join(runtimeRoot, "production", "current");
  if (!existsSync(current)) throw new Error("Production has no current release.");
  const release = realpathSync(current);
  const selectedRelease = realpathSync(
    expectedRelease ?? join(runtimeRoot, "production", "releases", expectedSha),
  );
  if (release !== selectedRelease) {
    throw new Error(`Production current points to ${release}, expected ${selectedRelease}.`);
  }
  const electronDist = join(release, "apps", "desktop", "node_modules", "electron", "dist");
  const electronExecutable =
    platform() === "darwin"
      ? join(electronDist, "Electron.app", "Contents", "MacOS", "Electron")
      : join(electronDist, platform() === "win32" ? "electron.exe" : "electron");
  for (const requiredPath of [
    join(release, "manifest.json"),
    join(release, "apps", "desktop", "scripts", "start-electron.mjs"),
    join(release, "apps", "desktop", "node_modules", "electron", "package.json"),
    join(release, "apps", "server", "dist", "bin.mjs"),
    electronExecutable,
  ]) {
    if (!existsSync(requiredPath)) {
      throw new Error(`Production release is missing ${requiredPath}.`);
    }
  }
  const manifest = JSON.parse(readFileSync(join(release, "manifest.json"), "utf8"));
  if (manifest.sha !== expectedSha) {
    throw new Error(`Production manifest is ${String(manifest.sha)}, expected ${expectedSha}.`);
  }
  const runtimeState = readRuntimeState(runtimeRoot);
  if (runtimeState.port !== numericPort) {
    throw new Error(
      `Production runtime reports port ${runtimeState.port}, expected ${numericPort}.`,
    );
  }
  if (
    previousRuntimeIdentity !== undefined &&
    runtimeState.pid === previousRuntimeIdentity.pid &&
    runtimeState.startedAt === previousRuntimeIdentity.startedAt
  ) {
    throw new Error(`Production runtime generation was not replaced.`);
  }
  if (launchedAfter !== undefined && Date.parse(runtimeState.startedAt) < launchedAfter) {
    throw new Error(`Production runtime state predates the selected release launch.`);
  }
  const inspected = await inspectProcess(runtimeState.pid, numericPort);
  if (inspected.pid !== runtimeState.pid || !inspected.alive) {
    throw new Error(`Production backend PID ${runtimeState.pid} is not alive.`);
  }
  if (
    typeof inspected.birthToken !== "string" ||
    Number.isNaN(Date.parse(inspected.birthToken)) ||
    Date.parse(inspected.birthToken) > Date.parse(runtimeState.startedAt)
  ) {
    throw new Error(
      `Production backend PID ${runtimeState.pid} does not match runtime generation.`,
    );
  }
  if (inspected.listenerPids?.length !== 1 || inspected.listenerPids[0] !== runtimeState.pid) {
    throw new Error(`Production backend PID ${runtimeState.pid} does not own port ${numericPort}.`);
  }
  if (!inspected.cwd || realpathSync(inspected.cwd) !== release) {
    throw new Error(`Production backend PID ${runtimeState.pid} is not running from ${release}.`);
  }
  const expectedServerEntry = join(release, "apps", "server", "dist", "bin.mjs");
  const executables = new Set([electronExecutable]);
  try {
    executables.add(realpathSync(electronExecutable));
  } catch {
    // The complete-release checks surface a missing runtime before this point.
  }
  const commandParts = Array.isArray(inspected.command) ? inspected.command : undefined;
  const command = String(inspected.command ?? "");
  const commandMatches = [...executables].some((executable) =>
    commandParts
      ? commandParts.length === 4 &&
        commandParts[0] === executable &&
        commandParts[1] === expectedServerEntry &&
        commandParts[2] === "--bootstrap-fd" &&
        /^\d+$/.test(commandParts[3])
      : command.startsWith(`${executable} ${expectedServerEntry} --bootstrap-fd `) &&
        /^\d+$/.test(command.slice(`${executable} ${expectedServerEntry} --bootstrap-fd `.length)),
  );
  if (!commandMatches) {
    throw new Error(
      `Production backend PID ${runtimeState.pid} did not launch ${expectedServerEntry}.`,
    );
  }
  const response = await fetchImpl(`http://127.0.0.1:${numericPort}/`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Production returned HTTP ${response.status}.`);
  const confirmedRuntimeState = readRuntimeState(runtimeRoot);
  if (
    confirmedRuntimeState.pid !== runtimeState.pid ||
    confirmedRuntimeState.startedAt !== runtimeState.startedAt ||
    confirmedRuntimeState.port !== runtimeState.port ||
    confirmedRuntimeState.origin !== runtimeState.origin
  ) {
    throw new Error(`Production runtime changed during verification.`);
  }
  const confirmedProcess = await inspectProcess(runtimeState.pid, numericPort);
  if (
    confirmedProcess.pid !== inspected.pid ||
    confirmedProcess.birthToken !== inspected.birthToken ||
    JSON.stringify(confirmedProcess.command) !== JSON.stringify(inspected.command) ||
    confirmedProcess.cwd !== inspected.cwd ||
    confirmedProcess.listenerPids?.length !== 1 ||
    confirmedProcess.listenerPids[0] !== runtimeState.pid
  ) {
    throw new Error(`Production backend ownership changed during verification.`);
  }
  console.log(`[t3-pipeline] production release ${expectedSha} passed on port ${numericPort}`);
  return { release, pid: runtimeState.pid, sha: expectedSha };
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (import.meta.url === entrypoint) await verifyProduction();
