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
  fail(`T3 server did not become ready on port ${port}.`);
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

async function deploy(name) {
  const paths = environmentPaths(name);
  const manifestPath = join(artifactRoot, "manifest.json");
  if (!existsSync(manifestPath)) fail(`Missing ${manifestPath}; run the build stage first.`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const release = join(paths.releases, manifest.sha);
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.releases, { recursive: true });
  if (
    !existsSync(join(release, "dist", "bin.mjs")) ||
    !existsSync(join(release, "desktop-dist-electron", "main.cjs"))
  ) {
    rmSync(release, { recursive: true, force: true });
    run("pnpm", ["deploy", "--legacy", "--filter", "t3", "--prod", release]);
    cpSync(join(artifactRoot, "dist"), join(release, "dist"), { recursive: true });
    cpSync(join(artifactRoot, "desktop-dist-electron"), join(release, "desktop-dist-electron"), {
      recursive: true,
    });
  }

  const current = existsSync(paths.current) ? realpathSync(paths.current) : undefined;
  cpSync(join(release, "dist"), join(root, "apps/server/dist"), { recursive: true });
  cpSync(join(release, "desktop-dist-electron"), join(root, "apps/desktop/dist-electron"), {
    recursive: true,
  });
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

  const stageLabel = name === "staging" ? "candidate" : "production";
  const logFd = openSync(paths.log, "a");
  const child = spawn(process.execPath, [join(root, "apps/desktop/scripts/start-electron.mjs")], {
    cwd: root,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      T3CODE_HOME: paths.home,
      T3CODE_PORT: String(paths.port),
      T3CODE_COMMIT_HASH: manifest.sha,
      T3CODE_DESKTOP_APP_USER_MODEL_ID: `com.t3tools.t3code.${stageLabel}`,
    },
  });
  child.unref();
  closeSync(logFd);
  writeFileSync(paths.pid, `${child.pid}\n`);
  try {
    await waitForServer(paths.port);
  } catch (error) {
    stop(name);
    if (current) {
      try {
        unlinkSync(paths.current);
      } catch {}
      symlinkSync(current, paths.current);
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

async function rollback(name) {
  const paths = environmentPaths(name);
  if (!existsSync(paths.previous)) fail(`No previous ${name} release is available.`);
  const previous = realpathSync(paths.previous);
  const manifestPath = join(previous, "package.json");
  if (!existsSync(manifestPath)) fail(`Previous release is missing ${manifestPath}.`);
  cpSync(join(previous, "dist"), join(root, "apps/server/dist"), { recursive: true });
  cpSync(join(previous, "desktop-dist-electron"), join(root, "apps/desktop/dist-electron"), {
    recursive: true,
  });
  stop(name);
  try {
    unlinkSync(paths.current);
  } catch {}
  symlinkSync(previous, paths.current);
  const logFd = openSync(paths.log, "a");
  const child = spawn(process.execPath, [join(root, "apps/desktop/scripts/start-electron.mjs")], {
    cwd: root,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      T3CODE_HOME: paths.home,
      T3CODE_PORT: String(paths.port),
      T3CODE_DESKTOP_APP_USER_MODEL_ID: `com.t3tools.t3code.${name}`,
    },
  });
  child.unref();
  closeSync(logFd);
  writeFileSync(paths.pid, `${child.pid}\n`);
  await waitForServer(paths.port);
  console.log(`[t3-pipeline] rolled ${name} back to ${previous}`);
}

try {
  if (command === "build") await build();
  else if (command === "deploy") await deploy(environment);
  else if (command === "rollback") await rollback(environment);
  else if (command === "status") await status(environment);
  else if (command === "stop") stop(environment);
  else fail("Usage: local-pipeline.mjs <build|deploy|rollback|status|stop> [staging|production]");
  process.exit(0);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
