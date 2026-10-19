import { randomUUID } from "node:crypto";
import { Broker } from "./broker.js";
import { BitwardenProvider } from "./providers.js";
import { BrokerError, parseRequest } from "./common.js";
import { access, stat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import runnerProgram from "./runner-program.js";
import watchdogProgram from "./watchdog-program.js";

async function resolveExecutable(program, searchPath) {
  const candidates = isAbsolute(program)
    ? [program]
    : searchPath
        .split(delimiter)
        .filter(isAbsolute)
        .map((directory) => join(directory, program));
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      if (!(await stat(canonical)).isFile()) continue;
      await access(canonical, constants.X_OK);
      return canonical;
    } catch {}
  }
  throw new Error("Executable unavailable.");
}

const terminal = new Set(["denied", "expired", "released", "failed", "completed", "revoked"]);

/** Host adapter. Operator methods are never exposed on the agent socket. */
export class T3CredentialBroker {
  #broker;
  #status;
  #listeners = new Set();
  #views = new Map();
  #notices = new Map();
  #executions = new Map();
  #waitingForUnlock = new Map();
  #error;
  #closing = false;
  constructor({
    runtime,
    workerEntrypoint,
    provider,
    now = Date.now,
    watchdog = true,
    approvalTimeout = null,
    noticeTimeout = 10000,
    platform = process.platform,
    searchPath = process.env.PATH ?? "",
  }) {
    this.searchPath = searchPath;
    this.runtime = runtime;
    this.workerEntrypoint = workerEntrypoint;
    this.provider = provider;
    this.now = now;
    this.watchdog = watchdog;
    this.approvalTimeout = approvalTimeout;
    this.noticeTimeout = noticeTimeout;
    this.#status = platform === "win32" ? "unsupported" : "locked";
  }
  state() {
    const snapshot = this.#broker?.snapshot() ?? { requests: [], notices: [], grants: [] };
    return {
      status: this.#status,
      mode: this.#broker?.provider.mode ?? "bitwarden",
      ...(this.#error ? { error: this.#error } : {}),
      requests: [
        ...[...this.#waitingForUnlock.values()].map((entry) => entry.request),
        ...snapshot.requests.filter((r) => r.kind === "exec" && !terminal.has(r.state)),
        ...snapshot.requests.filter((r) => r.kind === "exec" && terminal.has(r.state)).slice(0, 20),
      ].map((r) => ({
        requestId: r.request_id,
        state: r.state,
        site: r.site ?? "Direct item (CLI)",
        field: r.field,
        label: r.label,
        reason: r.reason,
        clientClaim: r.client,
        ttlSeconds: r.ttl_seconds,
        approvalDeadline: r.approval_deadline,
        ...(r.expires_at ? { expiresAt: r.expires_at } : {}),
        argv: r.argv,
        cwd: r.cwd,
        ...(r.origin ? { origin: r.origin } : {}),
        candidates: (r.candidates ?? []).map((c) => ({
          id: c.item_id,
          name: c.name,
          hosts: c.hosts,
        })),
        ...(r.grant_id ? { grantId: r.grant_id } : {}),
      })),
      notices: snapshot.notices.map((n) => ({
        noticeId: n.notice_id,
        requestId: n.request_id,
        grantId: n.grant_id,
        site: n.site,
        command: n.command,
        expiresAt: n.expires_at,
        revoked: n.revoked === true,
      })),
      grants: snapshot.grants.map((g) => ({
        grantId: g.grant_id,
        site: g.scope.site ?? "Direct item (CLI)",
        field: g.scope.field,
        argv: g.scope.argv,
        cwd: g.scope.cwd,
        maxTtl: g.max_ttl,
        ...(g.scope.origin ? { threadId: g.scope.origin.threadId } : {}),
      })),
    };
  }
  #publish() {
    const state = this.state();
    for (const listener of this.#listeners) listener(state);
    for (const r of this.#broker?.snapshot().requests ?? []) {
      if (terminal.has(r.state) && r.settled) this.#executions.get(r.request_id)?.finish(r);
    }
  }
  subscribe(sessionId, viewId, listener) {
    const key = `${sessionId}:${viewId}`;
    if (this.#views.has(key)) throw new BrokerError("Presenter already attached.");
    this.#views.set(key, { sessionId, visible: false });
    this.#listeners.add(listener);
    listener(this.state());
    return () => {
      this.#listeners.delete(listener);
      this.#views.delete(key);
      this.#lostView(key);
    };
  }
  #lostView(key) {
    for (const [id, entry] of this.#notices) {
      if (entry.owner !== key) continue;
      entry.action("failed");
      this.#notices.delete(id);
    }
    this.#publish();
  }
  async unlock(password, executable = "bw") {
    if (this.#status === "unsupported" || this.#status === "unlocking" || this.#closing)
      throw new BrokerError("Broker unavailable.");
    if (this.#status === "ready") return;
    if (!this.provider && (typeof password !== "string" || !password || password.length > 4096))
      throw new BrokerError("Invalid unlock.");
    this.#status = "unlocking";
    this.#error = undefined;
    this.#publish();
    const provider =
      this.provider ??
      new BitwardenProvider({
        executable,
        passwordPrompt: async () => {
          const value = password;
          password = undefined;
          return value;
        },
      });
    const broker = new Broker({
      runtime: this.runtime,
      provider,
      now: this.now,
      watchdog: this.watchdog,
      runnerProgram,
      watchdogProgram,
      workerEntrypoint: this.workerEntrypoint,
      approvalTimeout: this.approvalTimeout,
      onChange: () => this.#publish(),
      notifier: {
        show: (notice, action) => this.#show(notice, action),
        update: () => this.#publish(),
        dismiss: (id) => {
          this.#notices.delete(id);
          this.#publish();
        },
        close: () => {
          for (const entry of this.#notices.values()) entry.reject?.();
          this.#notices.clear();
        },
      },
    });
    try {
      await broker.initialize();
      if (this.#closing) {
        await broker.close();
        this.#status = "locked";
        return;
      }
      this.#broker = broker;
      this.#status = "ready";
      for (const entry of this.#waitingForUnlock.values()) entry.finish();
    } catch {
      await provider.close().catch(() => {});
      this.#status = "locked";
      this.#error =
        "Vault unlock failed. Authenticate the Bitwarden CLI on the server, then unlock privately in T3.";
      throw new BrokerError("Vault unlock failed.");
    } finally {
      password = undefined;
      this.#publish();
    }
  }
  #show(notice, action) {
    if (this.#notices.size >= 3 || ![...this.#views.values()].some((v) => v.visible))
      return Promise.reject(new BrokerError("No visible human presenter."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#notices.delete(notice.notice_id);
        reject(new BrokerError("Notification was not shown."));
      }, this.noticeTimeout);
      const entry = {
        action,
        owner: undefined,
        accept: (key) => {
          clearTimeout(timer);
          entry.owner = key;
          entry.accept = undefined;
          entry.reject = undefined;
          resolve();
        },
        reject: () => {
          clearTimeout(timer);
          reject(new BrokerError("Presenter disconnected."));
        },
      };
      this.#notices.set(notice.notice_id, entry);
      this.#publish();
    });
  }
  async action(sessionId, input) {
    if (input.type === "unlock") return this.unlock(input.password, input.executable);
    if (input.type === "lock") return this.lock();
    if (input.type === "presenter") {
      const key = `${sessionId}:${input.viewId}`;
      const view = this.#views.get(key);
      if (!view) throw new BrokerError("Presenter not attached.");
      view.visible = input.visible;
      if (!view.visible) this.#lostView(key);
      return;
    }
    if (input.type === "seen") {
      const key = `${sessionId}:${input.viewId}`;
      if (!this.#views.get(key)?.visible) throw new BrokerError("Presenter not visible.");
      this.#notices.get(input.noticeId)?.accept?.(key);
      return;
    }
    const waiting = this.#waitingForUnlock.get(input.requestId);
    if (waiting) {
      if (input.type === "stop" || (input.type === "decide" && input.decision === "deny")) {
        waiting.finish(input.type === "stop" ? "released" : "denied");
        this.#publish();
        return;
      }
      throw new BrokerError("Unlock the vault before approving access.");
    }
    const broker = this.#broker;
    if (!broker) throw new BrokerError("Vault is locked.");
    if (input.type === "decide")
      await broker.decide(
        input.requestId,
        input.decision !== "deny",
        input.candidateId,
        input.decision === "always",
      );
    else if (input.type === "dismiss") broker.dismissNotice(input.noticeId);
    else if (input.type === "revoke") await broker.revokeGrant(input.grantId);
    else if (input.type === "stop") await broker.release(input.requestId);
    else throw new BrokerError("Unknown operator operation.");
    this.#publish();
  }
  async execute(origin, input, signal, consumerEnvironment) {
    if (signal?.aborted)
      return Promise.reject(
        new BrokerError("Credential caller was cancelled.", 409, "caller_cancelled"),
      );
    if (this.#status === "unsupported")
      return Promise.reject(
        new BrokerError("Platform security adapters are unavailable.", 503, "unsupported_platform"),
      );
    const parsed = parseRequest(
      {
        kind: "exec",
        site: input.site,
        field: input.field,
        label: input.label,
        reason: input.reason,
        client: "T3 agent (identity supplied by server)",
        ttl_seconds: input.ttlSeconds,
        argv: input.argv,
        cwd: input.cwd ?? origin.workspace,
        file_env: "CB_CREDENTIAL_FILE",
      },
      { allowCommandName: true },
    );
    // Check on the server that will actually run the command, before searching
    // the vault or asking the human to authorize an unusable consumer.
    try {
      const [executable, directory] = await Promise.all([
        resolveExecutable(parsed.argv[0], this.searchPath),
        stat(parsed.cwd),
      ]);
      if (!directory.isDirectory()) throw new Error();
      // Approval, grant fingerprinting, and spawning all use this same path.
      // Changing PATH or retargeting its symlink cannot select another binary.
      parsed.argv = [executable, ...parsed.argv.slice(1)];
    } catch {
      throw new BrokerError(
        "Consumer unavailable: check that the command is installed on this environment’s PATH and its working directory exists.",
        400,
        "consumer_unavailable",
      );
    }
    if (signal?.aborted)
      throw new BrokerError("Credential caller was cancelled.", 409, "caller_cancelled");
    if (this.#closing) throw new BrokerError("Broker unavailable.", 503, "broker_unavailable");
    if (this.#status !== "ready") {
      const requestId = randomUUID();
      const result = await new Promise((resolve) => {
        const abort = () => finish("released");
        const finish = (state) => {
          this.#waitingForUnlock.delete(requestId);
          signal?.removeEventListener("abort", abort);
          resolve(state ? { requestId, state } : undefined);
        };
        this.#waitingForUnlock.set(requestId, {
          origin,
          finish,
          request: {
            ...parsed,
            request_id: requestId,
            state: "awaiting_unlock",
            origin,
            approval_deadline: null,
          },
        });
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        this.#publish();
      });
      if (result) return result;
    }
    if (signal?.aborted)
      throw new BrokerError("Credential caller was cancelled.", 409, "caller_cancelled");
    const broker = this.#broker;
    if (this.#closing || !broker || this.#status !== "ready")
      throw new BrokerError("Broker unavailable.", 503, "broker_unavailable");
    const request = broker.request(parsed, origin, consumerEnvironment);
    return new Promise((resolve, reject) => {
      const finish = (r) => {
        this.#executions.delete(request.request_id);
        signal?.removeEventListener("abort", abort);
        // Explicit allowlist: no choices, vault ids, command output, or credential path.
        resolve({
          requestId: r.request_id,
          state: r.state,
          ...(r.expires_at ? { expiresAt: r.expires_at } : {}),
          ...(r.exit_code !== undefined ? { exitCode: r.exit_code } : {}),
          ...(r.signal !== undefined ? { signal: r.signal } : {}),
          ...(r.failure_code ? { failureCode: r.failure_code } : {}),
        });
      };
      const abort = () => {
        void broker.release(request.request_id).then(
          () => this.#publish(),
          () => reject(new BrokerError("Caller cleanup failed.")),
        );
      };
      this.#executions.set(request.request_id, { origin, finish });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      this.#publish();
    });
  }
  async sweep() {
    await this.#broker?.sweep();
    this.#publish();
  }
  async cancelCall(toolCallId) {
    for (const entry of this.#waitingForUnlock.values()) {
      if (entry.origin.toolCallId === toolCallId) entry.finish("released");
    }
    for (const [id, execution] of this.#executions) {
      if (execution.origin.toolCallId === toolCallId) await this.#broker.release(id);
    }
    this.#publish();
  }
  async cancelSession(providerSessionId) {
    for (const entry of this.#waitingForUnlock.values()) {
      if (entry.origin.providerSessionId === providerSessionId) entry.finish("released");
    }
    for (const [id, execution] of this.#executions) {
      if (execution.origin.providerSessionId === providerSessionId) await this.#broker.release(id);
    }
    this.#publish();
  }
  async lock() {
    const broker = this.#broker;
    if (this.#status === "unlocking") throw new BrokerError("Unlock is in progress.");
    for (const entry of this.#waitingForUnlock.values()) entry.finish("released");
    if (broker) {
      await broker.close();
      this.#publish(); // Resolve every still-waiting tool call before forgetting requests.
      this.#broker = undefined;
    }
    if (this.#status !== "unsupported") this.#status = "locked";
    this.#publish();
  }
  async close() {
    this.#closing = true;
    for (const entry of this.#waitingForUnlock.values()) entry.finish("released");
    if (this.#status === "unlocking") return;
    await this.lock();
  }
}
