import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { BrokerError } from "./common.js";

// Dedicated private pipes: no desktop events or unlock values reach CLI output.
export class DesktopPresenter {
  #child;
  #starting;
  #closed = false;
  #pending = new Map();
  #notices = new Map();
  constructor({ executable, spawnProcess = spawn } = {}) {
    this.executable = executable;
    this.spawnProcess = spawnProcess;
  }
  async start() {
    if (this.#closed) throw new BrokerError("Desktop presenter is closed.");
    if (this.#child) return;
    if (this.#starting) return this.#starting;
    this.#starting = this.launch().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }
  async launch() {
    const executable = this.executable ?? createRequire(import.meta.url)("electron");
    const env = {};
    for (const key of [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "TMPDIR",
      "TMP",
      "TEMP",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "DISPLAY",
      "WAYLAND_DISPLAY",
      "XAUTHORITY",
      "XDG_RUNTIME_DIR",
      "DBUS_SESSION_BUS_ADDRESS",
      "SystemRoot",
      "WINDIR",
      "APPDATA",
      "LOCALAPPDATA",
      "USERPROFILE",
      "HOMEDRIVE",
      "HOMEPATH",
    ]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    const child = this.spawnProcess(
      executable,
      [fileURLToPath(new URL("../desktop/main.js", import.meta.url))],
      { stdio: ["pipe", "pipe", "ignore"], env },
    );
    this.#child = child;
    let buffer = "";
    const failed = () => {
      if (this.#child === child) this.#child = undefined;
      for (const entry of this.#pending.values())
        entry.finish(new BrokerError("Desktop presenter unavailable; no access granted."));
      for (const action of this.#notices.values()) action("failed");
      this.#notices.clear();
    };
    child.once("exit", failed);
    child.once("error", failed);
    child.stdin.on("error", () => {});
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
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.event === "response") {
          const entry = this.#pending.get(event.id);
          if (entry) entry.finish(undefined, event.value);
        } else if (["dismiss", "revoke"].includes(event.event)) {
          this.#notices.get(event.notice_id)?.(event.event);
        } else if (
          event.event === "manage" &&
          ["revoke", "release", "quit"].includes(event.action)
        ) {
          this.onAction?.(event.action, event.id);
        }
      }
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(new BrokerError("Desktop launch failed.")));
    });
    try {
      await this.ask("ready", {}, { timeout: 15000, started: true });
    } catch (error) {
      child.stdin.end();
      throw error;
    }
  }
  send(command, payload = {}) {
    if (!this.#child || this.#child.exitCode !== null)
      throw new BrokerError("Desktop presenter unavailable.");
    this.#child.stdin.write(JSON.stringify({ command, ...payload }) + "\n");
  }
  async ask(command, payload, { signal, timeout = 120000, started = false } = {}) {
    if (!started) await this.start();
    if (signal?.aborted) throw new BrokerError("Desktop request cancelled.");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.#pending.delete(id);
        error ? reject(error) : resolve(value);
      };
      const abort = () => {
        try {
          this.send("cancel", { id });
        } catch {}
        finish(new BrokerError("Desktop request cancelled."));
      };
      const timer = setTimeout(abort, Math.max(1, timeout));
      this.#pending.set(id, { finish });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.send(command, { id, payload });
      } catch (error) {
        finish(error);
      }
    });
  }
  async approve(request, { signal } = {}) {
    const value = await this.ask("approve", request, {
      signal,
      timeout: request.approval_deadline - Date.now(),
    });
    const choices = request.candidates ?? [{ item_id: request.item_id }];
    if (
      typeof value?.approve !== "boolean" ||
      (value.approve && !choices.some((c) => c.item_id === value.item_id)) ||
      (value.always && request.kind !== "exec")
    )
      throw new BrokerError("Invalid desktop approval.");
    return value;
  }
  async unlock() {
    const value = await this.ask("unlock", {});
    if (typeof value?.password !== "string" || !value.password || value.password.length > 4096)
      throw new BrokerError("Vault unlock cancelled.");
    return value.password;
  }
  async show(notice, action) {
    this.#notices.set(notice.notice_id, action);
    try {
      const value = await this.ask("notice", notice, { timeout: 15000 });
      if (value !== true) throw new BrokerError("Desktop notification did not appear.");
    } catch (error) {
      this.#notices.delete(notice.notice_id);
      throw error;
    }
  }
  update(notice) {
    try {
      this.send("update", { payload: notice });
    } catch {}
  }
  dismiss(id) {
    this.#notices.delete(id);
    try {
      this.send("dismiss", { notice_id: id });
    } catch {}
  }
  state(value) {
    try {
      this.send("state", { payload: value });
    } catch {}
  }
  close() {
    this.#closed = true;
    for (const entry of this.#pending.values())
      entry.finish(new BrokerError("Desktop presenter closed."));
    this.#notices.clear();
    this.#child?.stdin.end();
  }
}
