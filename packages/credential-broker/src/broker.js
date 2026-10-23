import { constants, closeSync, openSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { fork, spawn } from "node:child_process";
import { BrokerError, GUIDANCE, parseRequest } from "./common.js";
import { GrantStore, commandScope, scopeKey } from "./grants.js";

const leaseName = /^lease-[a-f0-9-]{36}\.secret$/;
const terminal = new Set(["denied", "expired", "released", "failed", "completed", "revoked"]);

async function privateDirectory(path) {
  await mkdir(path, { mode: 0o700 });
}
async function ensurePrivateDirectory(path) {
  try {
    await privateDirectory(path);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077
  ) {
    throw new BrokerError(
      "Runtime directories must be owned by this user, non-symlink directories with mode 0700.",
    );
  }
}

export class Broker {
  #requests = new Map();
  #lockOwned = false;
  #timer;
  #closing = false;
  #approvalQueue = Promise.resolve();
  #approvalControllers = new Map();
  #notices = new Map();
  constructor({
    runtime,
    provider,
    approvalTimeout = 120_000,
    now = Date.now,
    watchdog = true,
    approver,
    notifier,
    onChange = () => {},
    runnerProgram,
    watchdogProgram,
    workerEntrypoint,
  }) {
    this.onChange = onChange;
    this.runnerProgram = runnerProgram;
    this.watchdogProgram = watchdogProgram;
    this.workerEntrypoint = workerEntrypoint;
    this.runtime = resolve(runtime);
    this.provider = provider;
    this.approvalTimeout = approvalTimeout;
    this.now = now;
    this.watchdog = watchdog;
    this.approver = approver;
    this.notifier = notifier;
    this.grants = new GrantStore(this.runtime);
    this.leaseDir = join(this.runtime, "leases");
    this.lockPath = join(this.runtime, "broker.lock");
  }
  async initialize() {
    await ensurePrivateDirectory(this.runtime);
    try {
      const stat = await lstat(this.lockPath);
      if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077)
        throw new BrokerError("Unsafe broker lock.");
      const { pid } = JSON.parse(await readFile(this.lockPath, "utf8"));
      if (!Number.isInteger(pid) || pid <= 0) throw new BrokerError("Invalid broker lock.");
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") alive = false;
      }
      if (alive) throw new BrokerError("A broker already owns this runtime directory.", 409);
      await unlink(this.lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const fd = openSync(
      this.lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    this.#lockOwned = true;
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      await ensurePrivateDirectory(this.leaseDir);
      await this.grants.initialize();
      // Approvals are memory-only. No lease survives a broker restart.
      for (const name of await readdir(this.leaseDir))
        if (leaseName.test(name)) await unlink(join(this.leaseDir, name));
      await this.provider.initialize();
      this.#timer = setInterval(() => this.sweep().catch(() => {}), 250);
      this.#timer.unref();
    } catch (error) {
      await unlink(this.lockPath).catch(() => {});
      this.#lockOwned = false;
      throw error;
    } finally {
      closeSync(fd);
    }
  }
  changed() {
    if (this.changeQueued) return;
    this.changeQueued = true;
    queueMicrotask(() => {
      this.changeQueued = false;
      this.onChange();
    });
  }
  snapshot() {
    return {
      requests: [...this.#requests.values()].map((r) => this.public(r, true)).reverse(),
      grants: this.grants.list(),
      notices: this.notices(),
    };
  }
  request(input, origin, consumerEnvironment, { allowManual = false, allowSave = false } = {}) {
    if (this.#closing) throw new BrokerError("Broker is shutting down.", 503);
    const data = parseRequest(input);
    if ([...this.#requests.values()].filter((r) => !terminal.has(r.state)).length >= 100)
      throw new BrokerError("Too many open requests.", 429);
    const request = {
      ...data,
      allow_manual: allowManual,
      allow_save: allowSave && typeof this.provider.create === "function",
      request_id: randomUUID(),
      state: data.site ? "searching" : "pending",
      created_at: this.now(),
      approval_deadline: this.approvalTimeout === null ? null : this.now() + this.approvalTimeout,
    };
    // Only the embedding host can supply origin; parseRequest rejects it on the CLI wire.
    if (origin) request.origin = Object.freeze({ ...origin });
    if (consumerEnvironment)
      request.consumerEnvironment = Object.freeze({ ...consumerEnvironment });
    let state = request.state;
    Object.defineProperty(request, "state", {
      enumerable: true,
      get: () => state,
      set: (value) => {
        state = value;
        this.changed();
      },
    });
    this.#requests.set(request.request_id, request);
    this.changed();
    if (data.site) void this.search(request);
    else this.offerApproval(request);
    return this.public(request);
  }
  async search(request) {
    try {
      const candidates = await this.provider.search(request.site, (phase) => {
        if (request.state !== "searching" || !["syncing", "matching"].includes(phase)) return;
        request.search_phase = phase;
        this.changed();
      });
      await this.sweep();
      if (request.state !== "searching" || this.#closing) return;
      if (!candidates.length && !request.allow_manual && !request.allow_save) {
        request.state = "failed";
        request.failure_code = "no_matching_login";
        request.error = "No matching login found for this site.";
      } else {
        request.candidates = candidates;
        if (!candidates.length)
          request.error = "No matching login found. Enter a login to save and use it.";
        request.state = "pending";
        this.offerApproval(request);
      }
    } catch {
      if (request.state === "searching") {
        if (request.allow_manual || request.allow_save) {
          request.candidates = [];
          request.error = "Vault lookup failed. You can still enter a login to save and use it.";
          request.state = "pending";
          this.offerApproval(request);
        } else {
          request.state = "failed";
          request.failure_code = "vault_search_failed";
          request.error = "Vault login search failed; provider output is withheld.";
        }
      }
    }
  }
  offerApproval(request) {
    void this.tryAutomatic(request)
      .then((used) => {
        if (!used && request.state === "pending") this.queueApproval(request);
      })
      .catch(() => {
        if (request.state === "pending") {
          request.state = "failed";
          request.error = "Automatic approval failed; no credential access granted.";
        }
      });
  }
  async tryAutomatic(request) {
    if (request.kind !== "exec" || !this.grants.list().length) return false;
    let scope;
    try {
      scope = await commandScope(request, this.provider.mode);
    } catch {
      return false;
    }
    await this.sweep();
    if (request.state !== "pending" || this.#closing) return true;
    const grant = this.grants.match(scope, request);
    if (!grant || !this.notifier) return false;
    request.grant_id = grant.grant_id;
    const notice = {
      notice_id: randomUUID(),
      grant_id: grant.grant_id,
      request_id: request.request_id,
      site: request.site ?? "Direct vault item",
      label: request.label,
      command: request.argv[0].split("/").at(-1),
      created_at: this.now(),
      expires_at: this.now() + 300_000,
    };
    this.#notices.set(notice.notice_id, notice);
    this.changed();
    try {
      await this.notifier.show(notice, (action) => {
        if (action === "revoke") void this.revokeGrant(grant.grant_id).catch(() => {});
        if (action === "dismiss") this.dismissNotice(notice.notice_id);
        if (action === "failed") {
          notice.dismissed = true;
          this.changed();
          void this.release(request.request_id, "revoked").catch(() => {});
        }
      });
      // Start the full five minutes after the presenter confirms visibility,
      // so compilation/startup time does not shorten the notification.
      notice.created_at = this.now();
      notice.expires_at = notice.created_at + 300_000;
      this.notifier.update?.(notice);
      this.changed();
    } catch {
      this.#notices.delete(notice.notice_id);
      this.changed();
      request.grant_id = undefined;
      return false; // Notification failure requires fresh manual approval.
    }
    await this.sweep();
    if (request.state !== "pending" || !this.grants.get(grant.grant_id)) return true;
    request.auto_approved = true;
    await this.decide(request.request_id, true, grant.item_id, false, grant);
    return true;
  }
  queueApproval(request) {
    if (!this.approver) return;
    this.#approvalQueue = this.#approvalQueue
      .then(async () => {
        await this.sweep();
        if (request.state !== "pending" || this.#closing) return;
        const controller = new AbortController();
        this.#approvalControllers.set(request.request_id, controller);
        try {
          const decision = await this.approver(this.public(request, true), {
            signal: controller.signal,
          });
          await this.sweep();
          if (request.state === "pending" && !this.#closing) {
            if (typeof decision?.approve !== "boolean") throw new Error();
            await this.decide(
              request.request_id,
              decision.approve,
              decision.item_id,
              decision.always === true,
            );
          }
        } catch {
          if (request.state === "pending") {
            request.state = "failed";
            request.error =
              "Desktop approval failed; no credential access granted. Check the companion app.";
          }
        } finally {
          this.#approvalControllers.delete(request.request_id);
        }
      })
      .catch(() => {});
  }
  public(request, operator = false) {
    const {
      request_id,
      state,
      item_id,
      label,
      field,
      reason,
      client,
      ttl_seconds,
      created_at,
      approval_deadline,
      expires_at,
      error,
    } = request;
    const result = {
      kind: request.kind,
      request_id,
      state,
      item_id,
      label,
      field,
      reason,
      client,
      ttl_seconds,
      created_at,
      approval_deadline,
      guidance: GUIDANCE,
    };
    if (expires_at) result.expires_at = expires_at;
    if (request.grant_id) result.grant_id = request.grant_id;
    if (request.auto_approved) result.auto_approved = true;
    if (request.site) result.site = request.site;
    if (operator && request.search_phase) result.search_phase = request.search_phase;
    if (operator && request.candidates) result.candidates = request.candidates;
    if (operator) result.settled = !request.cleanup_pending;
    if (operator && request.origin) result.origin = request.origin;
    if (operator) result.allow_save = request.allow_save === true;
    if (state === "active" && request.kind === "file") result.path = request.path;
    if (request.kind === "exec") {
      result.argv = request.argv;
      result.cwd = request.cwd;
      result.file_env = request.file_env;
      result.output_policy =
        "Child stdout and stderr are discarded. Only execution metadata is returned.";
      if (request.exit_code !== undefined) result.exit_code = request.exit_code;
      if (request.signal) result.signal = request.signal;
    }
    if (request.failure_code) result.failure_code = request.failure_code;
    if (error) result.error = error;
    return result;
  }
  find(id) {
    const request = this.#requests.get(id);
    if (!request) throw new BrokerError("Request not found.", 404);
    return request;
  }
  async status(id) {
    await this.sweep();
    return this.public(this.find(id));
  }
  async list() {
    await this.sweep();
    return [...this.#requests.values()].map((r) => this.public(r, true)).reverse();
  }
  notices() {
    return [...this.#notices.values()].filter((n) => !n.dismissed && this.now() < n.expires_at);
  }
  dismissNotice(id) {
    const notice = this.#notices.get(id);
    if (!notice) throw new BrokerError("Notification not found.", 404);
    notice.dismissed = true;
    this.changed();
    this.notifier?.dismiss?.(id);
  }
  async revokeGrant(id) {
    let failure;
    try {
      await this.grants.revoke(id);
    } catch {
      failure = true;
    }
    for (const request of this.#requests.values()) {
      if (request.grant_id === id && !terminal.has(request.state))
        await this.release(request.request_id, "revoked");
    }
    for (const notice of this.#notices.values()) {
      if (notice.grant_id === id) {
        notice.revoked = true;
        this.notifier?.update?.(notice);
      }
    }
    this.changed();
    if (failure)
      throw new BrokerError("Access stopped, but persisting grant revocation failed.", 500);
    return { grant_id: id, state: "revoked" };
  }
  async saveLogin(id, login) {
    await this.sweep();
    const request = this.find(id);
    if (request.state !== "pending" || !request.allow_save || this.#closing)
      throw new BrokerError("Request is no longer awaiting a saved login.", 409);
    if (
      typeof login.username !== "string" ||
      typeof login.password !== "string" ||
      login.username.length > 4096 ||
      login.password.length > 4096 ||
      (request.field !== "password" && !login.username) ||
      (request.field !== "username" && !login.password)
    )
      throw new BrokerError("Enter the requested login fields.", 400);
    this.#approvalControllers.get(id)?.abort();
    request.state = "saving";
    request.error = undefined;
    try {
      const candidate = await this.provider.create(request.site, login);
      await this.sweep();
      // Saving in the vault cannot authorize a caller that was stopped meanwhile.
      if (request.state !== "saving" || this.#closing) return;
      request.candidates.push(candidate);
      request.state = "pending";
      return await this.decide(id, true, candidate.item_id);
    } catch {
      if (request.state === "saving") {
        request.error = "Could not confirm the saved login. Check Bitwarden before retrying.";
        request.state = "pending";
      }
      throw new BrokerError("Could not save and use the login.", 502);
    }
  }
  async decide(id, approve, itemId, always = false, automaticGrant) {
    await this.sweep();
    const request = this.find(id);
    if (request.state !== "pending" && !(request.state === "searching" && !approve))
      throw new BrokerError("Request is no longer awaiting approval.", 409);
    this.#approvalControllers.get(id)?.abort();
    if (!approve) {
      request.state = "denied";
      return this.public(request);
    }
    if (request.site) {
      const selected =
        itemId ?? (request.candidates.length === 1 ? request.candidates[0].item_id : undefined);
      if (!request.candidates.some((candidate) => candidate.item_id === selected))
        throw new BrokerError("Choose one of the matching vault logins.");
      request.item_id = selected;
    } else if (itemId && itemId !== request.item_id) {
      throw new BrokerError("Selected item does not match the request.");
    }
    request.state = "preparing";
    let file;
    try {
      if (always) {
        if (!this.notifier) throw new Error();
        const scope = await commandScope(request, this.provider.mode);
        if (request.state !== "preparing" || this.#closing) return this.public(request);
        const grant = await this.grants.add(scope, request.item_id, request.ttl_seconds);
        request.grant_id = grant.grant_id;
      }
      if (automaticGrant && !this.grants.get(automaticGrant.grant_id)) throw new Error();
      let value = await this.provider.get(request.item_id, request.field, request.site);
      const grant = request.grant_id && this.grants.get(request.grant_id);
      if (
        request.grant_id &&
        (!grant || scopeKey(await commandScope(request, this.provider.mode)) !== grant.key)
      )
        throw new Error();
      // Release/shutdown can cancel an in-flight provider call.
      await this.sweep();
      if (request.state !== "preparing" || this.#closing) return this.public(request);
      file = join(this.leaseDir, `lease-${request.request_id}.secret`);
      const fd = openSync(
        file,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, value, { encoding: "utf8" });
      } finally {
        closeSync(fd);
        value = undefined;
      }
      request.expires_at = this.now() + request.ttl_seconds * 1000;
      if (this.watchdog) {
        const timer = spawn(
          process.execPath,
          [
            ...(this.workerEntrypoint
              ? [...this.workerEntrypoint, "watchdog"]
              : this.watchdogProgram
                ? ["--input-type=module", "-e", this.watchdogProgram, "--", "watchdog"]
                : [fileURLToPath(new URL("./watchdog.js", import.meta.url))]),
            file,
            String(Date.now() + request.ttl_seconds * 1000),
          ],
          {
            detached: true,
            stdio: "ignore",
            env:
              this.workerEntrypoint || process.versions.electron
                ? { ELECTRON_RUN_AS_NODE: "1" }
                : {},
          },
        );
        await new Promise((resolve, reject) => {
          timer.once("spawn", resolve);
          timer.once("error", reject);
        });
        timer.unref();
      }
      if (request.state !== "preparing" || this.#closing) {
        await unlink(file);
        return this.public(request);
      }
      request.path = file;
      if (request.kind === "exec") await this.execute(request);
      else request.state = "active";
    } catch {
      if (file) await unlink(file).catch(() => {});
      if (request.state === "preparing") {
        request.state = "failed";
        request.error =
          "Credential delivery failed. Check the provider in the human terminal; no provider output is exposed.";
      }
    }
    return this.public(request);
  }
  async release(id, state = "released") {
    const request = this.find(id);
    if (!terminal.has(request.state)) {
      request.cleanup_pending = true;
      request.state = state;
      this.#approvalControllers.get(id)?.abort();
      // Concurrent cancellation paths share the same cleanup milestone.
      request.cleanupPromise = (async () => {
        try {
          if (request.runner?.connected) request.runner.disconnect();
          if (request.path) await this.remove(request);
        } catch (error) {
          request.state = "failed";
          throw error;
        } finally {
          if (request.runnerExit) await request.runnerExit;
          request.cleanup_pending = false;
          this.changed();
        }
      })();
    }
    if (request.cleanupPromise) await request.cleanupPromise;
    return this.public(request);
  }
  async remove(request) {
    try {
      await unlink(request.path);
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new BrokerError("Credential cleanup failed; manual cleanup required.", 500);
    }
  }
  async sweep() {
    const now = this.now();
    for (const [id, notice] of this.#notices) {
      if (now >= notice.expires_at) {
        this.notifier?.dismiss?.(id);
        this.#notices.delete(id);
        this.changed();
      }
    }
    for (const request of this.#requests.values()) {
      if (
        ["pending", "searching", "saving", "preparing"].includes(request.state) &&
        request.approval_deadline !== null &&
        now >= request.approval_deadline
      ) {
        await this.release(request.request_id, "expired");
      }
      if (["active", "running"].includes(request.state) && now >= request.expires_at) {
        await this.release(request.request_id, "expired");
      }
      if (terminal.has(request.state) && now - request.created_at > 3_600_000)
        this.#requests.delete(request.request_id);
    }
  }
  async execute(request) {
    const env = {};
    // Inherit ordinary OS configuration only, excluding ambient credentials.
    for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "USER", "LOGNAME"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    if (this.workerEntrypoint || process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
    if (request.consumerEnvironment?.CB_BROWSER_ENDPOINT)
      env.CB_BROWSER_ENDPOINT = request.consumerEnvironment.CB_BROWSER_ENDPOINT;
    const runner = fork(
      this.workerEntrypoint?.[0] ??
        (this.runnerProgram ? "-e" : fileURLToPath(new URL("./runner.js", import.meta.url))),
      [
        ...(this.workerEntrypoint
          ? [...this.workerEntrypoint.slice(1), "runner"]
          : this.runnerProgram
            ? [this.runnerProgram, "--", "runner"]
            : []),
        JSON.stringify({
          argv: request.argv,
          cwd: request.cwd,
          file: request.path,
          file_env: request.file_env,
          expires_at: request.expires_at,
        }),
      ],
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env,
        execArgv: this.workerEntrypoint ? [] : this.runnerProgram ? ["--input-type=module"] : [],
      },
    );
    request.runner = runner;
    request.runnerExit = new Promise((resolve) => {
      runner.once("exit", resolve);
      runner.once("close", resolve);
      runner.once("error", () => {
        if (!runner.pid) resolve();
      });
    });
    await new Promise((resolve) => {
      let settled = false;
      const ready = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const fail = async () => {
        if (["preparing", "running"].includes(request.state)) {
          request.cleanup_pending = true;
          request.state = "failed";
          request.failure_code = "supervisor_start_failed";
          request.error =
            "Approved command failed to start or supervise; child output is withheld.";
          request.cleanupPromise = (async () => {
            try {
              await this.remove(request);
            } catch {
              request.failure_code = "credential_cleanup_failed";
              request.error = "Credential cleanup failed; manual cleanup required.";
            } finally {
              await request.runnerExit;
              request.cleanup_pending = false;
              this.changed();
            }
          })();
          await request.cleanupPromise;
        }
        ready();
      };
      runner.on("message", async (message) => {
        if (
          !message ||
          !["running", "completed", "failed", "expired", "released"].includes(message.state)
        )
          return;
        if (["preparing", "running"].includes(request.state)) {
          request.state = message.state;
          if (message.state !== "running") {
            request.exit_code = Number.isInteger(message.exit_code) ? message.exit_code : null;
            request.signal = typeof message.signal === "string" ? message.signal : null;
            if (message.state === "failed") {
              request.error = "Approved command failed. Child output is withheld.";
              if (
                ["consumer_start_failed", "credential_cleanup_failed"].includes(
                  message.failure_code,
                )
              )
                request.failure_code = message.failure_code;
            }
            await this.remove(request).catch(() => {});
          }
        } else if (runner.connected) runner.disconnect();
        ready();
      });
      runner.once("error", fail);
      runner.once("exit", fail);
    });
  }
  async close() {
    this.#closing = true;
    clearInterval(this.#timer);
    this.notifier?.close?.();
    let failure;
    for (const request of this.#requests.values()) {
      try {
        await this.release(request.request_id);
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      await this.provider.close();
    } catch (error) {
      failure ??= error;
    }
    if (this.#lockOwned) {
      await unlink(this.lockPath);
      this.#lockOwned = false;
    }
    if (failure) throw failure;
  }
}
