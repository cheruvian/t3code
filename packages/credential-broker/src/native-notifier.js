import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, chmod, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrokerError } from "./common.js";

export class NativeNotifier {
  #child;
  #starting;
  #entries = new Map();
  #closed = false;
  constructor(runtime) {
    this.runtime = runtime;
  }
  async start() {
    if (this.#closed) throw new BrokerError("Notification presenter is closed.");
    if (this.#child && !this.#child.killed && this.#child.exitCode === null) return;
    if (this.#starting) return this.#starting;
    this.#starting = this.launch().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }
  async launch() {
    if (process.platform !== "darwin")
      throw new BrokerError("Native use notifications require macOS.");
    const source = fileURLToPath(new URL("../native/toast.swift", import.meta.url));
    const digest = createHash("sha256")
      .update(await readFile(source))
      .digest("hex");
    const binary = join(this.runtime, `native-toast-${digest}`);
    try {
      const info = await lstat(binary);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid() ||
        info.mode & 0o077
      )
        throw new Error();
    } catch (error) {
      if (error.code !== "ENOENT") throw new BrokerError("Unsafe native notification executable.");
      try {
        await promisify(execFile)("/usr/bin/swiftc", ["-O", source, "-o", binary], {
          timeout: 60_000,
          maxBuffer: 64 * 1024,
          env: { PATH: "/usr/bin:/bin" },
        });
        await chmod(binary, 0o700);
      } catch {
        throw new BrokerError("Native notification build failed; automatic access is disabled.");
      }
    }
    if (this.#closed) throw new BrokerError("Notification presenter is closed.");
    const child = spawn(binary, [], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { PATH: "/usr/bin:/bin" },
    });
    this.#child = child;
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 65536) {
        child.kill();
        return;
      }
      let boundary;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        try {
          const event = JSON.parse(line);
          const entry = this.#entries.get(event.notice_id);
          if (!entry) continue;
          if (event.event === "shown") {
            clearTimeout(entry.timer);
            entry.resolve();
          } else if (["revoke", "dismiss"].includes(event.event)) entry.action(event.event);
        } catch {}
      }
    });
    child.stdin.on("error", () => {});
    const failed = () => {
      if (this.#child === child) this.#child = undefined;
      for (const entry of this.#entries.values()) {
        clearTimeout(entry.timer);
        entry.reject(new BrokerError("Native notification unavailable."));
        entry.action("failed");
      }
      this.#entries.clear();
    };
    child.once("exit", failed);
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }
  async show(notice, action) {
    await this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.dismiss(notice.notice_id);
        reject(new BrokerError("Native notification did not appear."));
      }, 10000);
      this.#entries.set(notice.notice_id, { resolve, reject, action, timer });
      this.#child.stdin.write(
        JSON.stringify({ ...notice, command: "show", executable: notice.command }) + "\n",
      );
    });
  }
  update(notice) {
    this.#child?.stdin.write(JSON.stringify({ ...notice, command: "update" }) + "\n");
  }
  dismiss(id) {
    this.#entries.delete(id);
    this.#child?.stdin.write(JSON.stringify({ command: "dismiss", notice_id: id }) + "\n");
  }
  close() {
    this.#closed = true;
    for (const entry of this.#entries.values()) {
      clearTimeout(entry.timer);
      entry.reject(new BrokerError("Notification presenter is closed."));
    }
    this.#entries.clear();
    this.#child?.stdin.end();
  }
}
