// This supervisor owns the approved command's lifetime independently of the broker.
// The credential value never enters process arguments, IPC, or command output.
import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";

const { argv, cwd, file, file_env, expires_at, host_worker } = JSON.parse(process.argv[2]);
let child;
let finished = false;
let timer;

async function finish(state, exit_code = null, signal = null, failure_code) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
  try {
    await unlink(file);
  } catch (error) {
    if (error.code !== "ENOENT") {
      state = "failed";
      failure_code = "credential_cleanup_failed";
    }
  }
  if (process.connected) {
    process.send({ state, exit_code, signal, ...(failure_code ? { failure_code } : {}) }, () =>
      process.disconnect(),
    );
  }
}

process.on("disconnect", () => finish("released"));
process.on("SIGTERM", () => finish("released"));
process.on("SIGINT", () => finish("released"));
timer = setTimeout(() => finish("expired"), Math.max(0, expires_at - Date.now()));
try {
  if (!process.connected || Date.now() >= expires_at) {
    await finish(process.connected ? "expired" : "released");
    process.exit(0);
  }
  const consumerEnvironment = { ...process.env };
  // Internal workers reuse the Electron host executable, which needs Node mode.
  // Ordinary approved commands must not inherit Electron's launch controls.
  if (!host_worker) delete consumerEnvironment.ELECTRON_RUN_AS_NODE;
  child = spawn(argv[0], argv.slice(1), {
    cwd,
    env: { ...consumerEnvironment, [file_env]: file },
    detached: true,
    // Discard raw and transformed output; do not depend on redaction heuristics.
    stdio: "ignore",
  });
  child.once("spawn", () => {
    if (!finished && process.connected) process.send({ state: "running" });
  });
  child.once("error", () => finish("failed", null, null, "consumer_start_failed"));
  child.once("exit", (code, signal) => finish("completed", code, signal));
} catch {
  finish("failed", null, null, "consumer_start_failed");
}
