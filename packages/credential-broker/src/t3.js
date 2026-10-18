import { Broker } from "./broker.js";
import { BitwardenProvider } from "./providers.js";
import { BrokerError, parseRequest } from "./common.js";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import runnerProgram from "./runner-program.js";
import watchdogProgram from "./watchdog-program.js";

const terminal = new Set(["denied", "expired", "released", "failed", "completed", "revoked"]);

/** Host adapter. Operator methods are never exposed on the agent socket. */
export class T3CredentialBroker {
  #broker;
  #status;
  #listeners = new Set();
  #views = new Map();
  #notices = new Map();
  #executions = new Map();
  #error;
  #closing = false;
  constructor({
    runtime,
    workerEntrypoint,
    provider,
    now = Date.now,
    watchdog = true,
    approvalTimeout = 120000,
    noticeTimeout = 10000,
    platform = process.platform,
  }) {
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
        return;
      }
      this.#broker = broker;
      this.#status = "ready";
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
  async execute(origin, input, signal) {
    const broker = this.#broker;
    if (signal?.aborted)
      return Promise.reject(
        new BrokerError("Credential caller was cancelled.", 409, "caller_cancelled"),
      );
    if (this.#status === "unsupported")
      return Promise.reject(
        new BrokerError("Platform security adapters are unavailable.", 503, "unsupported_platform"),
      );
    if (!broker || this.#status !== "ready")
      return Promise.reject(
        new BrokerError(
          "Unlock the vault privately in T3 first.",
          503,
          this.#status === "unlocking" ? "vault_unlocking" : "vault_locked",
        ),
      );
    const parsed = parseRequest({
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
    });
    // Check on the server that will actually run the command, before searching
    // the vault or asking the human to authorize an unusable consumer.
    try {
      const [executable, directory] = await Promise.all([stat(parsed.argv[0]), stat(parsed.cwd)]);
      if (!executable.isFile() || !directory.isDirectory()) throw new Error();
      await access(parsed.argv[0], constants.X_OK);
    } catch {
      throw new BrokerError(
        "Consumer unavailable: check the absolute executable and working directory on this environment.",
        400,
        "consumer_unavailable",
      );
    }
    if (signal?.aborted)
      throw new BrokerError("Credential caller was cancelled.", 409, "caller_cancelled");
    if (this.#closing || this.#broker !== broker || this.#status !== "ready")
      throw new BrokerError("Broker unavailable.", 503, "broker_unavailable");
    const request = broker.request(parsed, origin);
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
    for (const [id, execution] of this.#executions) {
      if (execution.origin.toolCallId === toolCallId) await this.#broker.release(id);
    }
    this.#publish();
  }
  async cancelSession(providerSessionId) {
    for (const [id, execution] of this.#executions) {
      if (execution.origin.providerSessionId === providerSessionId) await this.#broker.release(id);
    }
    this.#publish();
  }
  async lock() {
    const broker = this.#broker;
    if (this.#status === "unlocking") throw new BrokerError("Unlock is in progress.");
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
    await this.lock();
  }
}
