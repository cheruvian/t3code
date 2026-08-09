#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [command, environment = ""] = process.argv.slice(2);
const root = resolve(import.meta.dirname, "../..");
const runtimeRoot = resolve(process.env.T3_PIPELINE_RUNTIME_ROOT ?? join(homedir(), "t3-runtime"));
const artifactRoot = resolve(
  process.env.T3_PIPELINE_ARTIFACT_ROOT ?? join(root, "build", "pipeline-artifact"),
);
const environmentConfig = {
  staging: { port: 17773 },
  production: { port: 17774 },
};

function fail(message) {
  console.error(`[t3-pipeline] ${message}`);
  process.exit(1);
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
    pid: join(base, "electron.pid"),
    log: join(base, "electron.log"),
    port: config.port,
  };
}

function desktopRuntimePaths(release) {
  const root = join(release, "apps", "desktop");
  return {
    root,
    launcher: join(root, "scripts", "start-electron.mjs"),
    electronPackage: join(root, "node_modules", "electron", "package.json"),
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

function launchRelease(name, paths, release, commitHash) {
  const runtime = desktopRuntimePaths(release);
  if (!hasCompleteReleaseRuntime(release)) {
    throw new Error(`Release ${release} is missing its self-contained desktop runtime.`);
  }
  const stageLabel = name === "staging" ? "candidate" : "production";
  const logFd = openSync(paths.log, "a");
  const child = spawn(process.execPath, [runtime.launcher], {
    cwd: release,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      T3CODE_HOME: paths.home,
      T3CODE_PORT: String(paths.port),
      T3CODE_COMMIT_HASH: commitHash,
      T3CODE_DESKTOP_APP_USER_MODEL_ID: `com.t3tools.t3code.${stageLabel}`,
      T3CODE_DESKTOP_STAGE_LABEL: stageLabel === "candidate" ? "Candidate" : "Production",
    },
  });
  child.unref();
  closeSync(logFd);
  writeFileSync(paths.pid, `${child.pid}\n`);
}

function readPid(paths) {
  if (!existsSync(paths.pid)) return undefined;
  const pid = Number.parseInt(readFileSync(paths.pid, "utf8").trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stop(name) {
  const paths = environmentPaths(name);
  const pid = readPid(paths);
  if (pid === undefined) return;
  if (isAlive(pid)) {
    console.log(`[t3-pipeline] stopping ${name} server pid ${pid}`);
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 15_000;
    while (isAlive(pid) && Date.now() < deadline)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
  }
  unlinkSync(paths.pid);
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

export async function deploy(
  name,
  { launch = launchRelease, waitUntilReady = waitForServer } = {},
) {
  const paths = environmentPaths(name);
  const manifestPath = join(artifactRoot, "manifest.json");
  if (!existsSync(manifestPath)) fail(`Missing ${manifestPath}; run the build stage first.`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const release = join(paths.releases, manifest.sha);
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.releases, { recursive: true });
  const current = existsSync(paths.current) ? realpathSync(paths.current) : undefined;
  if (!hasCompleteReleaseRuntime(release)) {
    if (current === release) stop(name);
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

  stop(name);
  if (current && current !== release) {
    try {
      unlinkSync(paths.previous);
    } catch {}
    symlinkSync(current, paths.previous);
  }
  try {
    unlinkSync(paths.current);
  } catch {}
  symlinkSync(release, paths.current);

  try {
    launch(name, paths, release, manifest.sha);
    await waitUntilReady(paths.port);
  } catch (error) {
    stop(name);
    try {
      unlinkSync(paths.current);
    } catch {}
    if (current) {
      symlinkSync(current, paths.current);
      const previousManifest = join(current, "manifest.json");
      const previousHash = existsSync(previousManifest)
        ? JSON.parse(readFileSync(previousManifest, "utf8")).sha
        : "unknown";
      launch(name, paths, current, previousHash);
      await waitUntilReady(paths.port);
    }
    throw error;
  }
  console.log(`[t3-pipeline] ${name} is running at http://127.0.0.1:${paths.port}`);
}

async function status(name) {
  const paths = environmentPaths(name);
  const pid = readPid(paths);
  console.log(
    JSON.stringify(
      {
        environment: name,
        port: paths.port,
        home: paths.home,
        current: existsSync(paths.current) ? realpathSync(paths.current) : null,
        pid: pid ?? null,
        running: pid === undefined ? false : isAlive(pid),
      },
      null,
      2,
    ),
  );
}

async function start(name) {
  const paths = environmentPaths(name);
  if (!existsSync(paths.current)) fail(`No current ${name} release is available.`);
  const release = realpathSync(paths.current);
  const manifestPath = join(release, "manifest.json");
  const commitHash = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8")).sha
    : "unknown";
  stop(name);
  launchRelease(name, paths, release, commitHash);
  await waitForServer(paths.port);
  console.log(`[t3-pipeline] ${name} started from ${release}`);
}

async function rollback(name) {
  const paths = environmentPaths(name);
  if (!existsSync(paths.previous)) fail(`No previous ${name} release is available.`);
  const previous = realpathSync(paths.previous);
  const manifestPath = join(previous, "package.json");
  if (!existsSync(manifestPath)) fail(`Previous release is missing ${manifestPath}.`);
  stop(name);
  try {
    unlinkSync(paths.current);
  } catch {}
  symlinkSync(previous, paths.current);
  const rollbackHash = existsSync(join(previous, "manifest.json"))
    ? JSON.parse(readFileSync(join(previous, "manifest.json"), "utf8")).sha
    : "unknown";
  launchRelease(name, paths, previous, rollbackHash);
  await waitForServer(paths.port);
  console.log(`[t3-pipeline] rolled ${name} back to ${previous}`);
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (import.meta.url === entrypoint) {
  try {
    if (command === "build") await build();
    else if (command === "deploy") await deploy(environment);
    else if (command === "start") await start(environment);
    else if (command === "rollback") await rollback(environment);
    else if (command === "status") await status(environment);
    else if (command === "stop") stop(environment);
    else
      fail(
        "Usage: local-pipeline.mjs <build|deploy|start|rollback|status|stop> [staging|production]",
      );
    process.exit(0);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
