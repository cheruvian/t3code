import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { lstat, readFile, open, rename, unlink, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BrokerError } from "./common.js";

async function fingerprint(path) {
  const canonical = await realpath(path);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(canonical)) hash.update(chunk);
  return { path: canonical, sha256: hash.digest("hex") };
}

export async function commandScope(request, provider) {
  if (request.kind !== "exec")
    throw new BrokerError("Always allow requires a supervised exec command.");
  const files = [await fingerprint(request.argv[0])];
  for (const arg of request.argv.slice(1)) {
    if (!/\.(mjs|cjs|js|ts|py|sh|rb)$/.test(arg)) continue;
    try {
      files.push(await fingerprint(resolve(request.cwd, arg)));
    } catch {
      throw new BrokerError("Cannot verify command script for always allow.");
    }
  }
  return {
    provider,
    site: request.site ?? null,
    kind: request.kind,
    field: request.field,
    client: request.origin ? null : request.client,
    origin: request.origin
      ? {
          environmentId: request.origin.environmentId,
          threadId: request.origin.threadId,
          providerInstanceId: request.origin.providerInstanceId,
          workspace: request.origin.workspace,
        }
      : null,
    argv: [files[0].path, ...request.argv.slice(1)],
    ...(request.argv0 ? { argv0: request.argv0 } : {}),
    cwd: await realpath(request.cwd),
    file_env: request.file_env,
    files,
  };
}
export const scopeKey = (scope) => createHash("sha256").update(JSON.stringify(scope)).digest("hex");

export class GrantStore {
  #grants = new Map();
  #writes = Promise.resolve();
  constructor(runtime) {
    this.path = join(runtime, "grants.json");
  }
  async initialize() {
    try {
      const info = await lstat(this.path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid() ||
        info.mode & 0o077
      )
        throw new Error();
      const data = JSON.parse(await readFile(this.path, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.grants) || data.grants.length > 1000)
        throw new Error();
      for (const grant of data.grants) {
        if (
          !/^[a-f0-9-]{36}$/.test(grant.grant_id) ||
          !/^[a-f0-9]{64}$/.test(grant.key) ||
          !/^[a-f0-9-]{36}$/.test(grant.item_id) ||
          !Number.isInteger(grant.max_ttl) ||
          grant.max_ttl < 5 ||
          grant.max_ttl > 300 ||
          scopeKey(grant.scope) !== grant.key
        )
          throw new Error();
        this.#grants.set(grant.grant_id, grant);
      }
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new BrokerError("Unsafe or invalid grant store; no automatic approvals loaded.");
    }
  }
  list() {
    return [...this.#grants.values()].filter(
      (grant) => !grant.expires_at || grant.expires_at > Date.now(),
    );
  }
  get(id) {
    return this.list().find((grant) => grant.grant_id === id);
  }
  match(scope, request) {
    const key = scopeKey(scope);
    const ids = request.site
      ? request.candidates.filter((c) => !c.hostMismatch).map((c) => c.item_id)
      : [request.item_id];
    const matches = this.list().filter(
      (g) => g.key === key && ids.includes(g.item_id) && request.ttl_seconds <= g.max_ttl,
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  async add(scope, item_id, max_ttl, durationSeconds) {
    if (durationSeconds !== undefined && durationSeconds !== 3600)
      throw new BrokerError("Unsupported approval duration.");
    const grant = {
      grant_id: randomUUID(),
      key: scopeKey(scope),
      scope,
      item_id,
      max_ttl,
      created_at: Date.now(),
      ...(durationSeconds ? { expires_at: Date.now() + durationSeconds * 1000 } : {}),
    };
    const existing = this.list().find((g) => g.key === grant.key && g.item_id === item_id);
    if (existing) {
      if (existing.expires_at !== undefined || durationSeconds !== undefined) {
        await this.revoke(existing.grant_id);
      } else return existing;
    }
    if (this.#grants.size >= 1000) throw new BrokerError("Too many always-allow grants.");
    this.#grants.set(grant.grant_id, grant);
    try {
      await this.save();
    } catch (error) {
      this.#grants.delete(grant.grant_id);
      throw error;
    }
    return grant;
  }
  async revoke(id) {
    this.#grants.delete(id); // Future matches stop synchronously before disk I/O.
    await this.save();
  }
  save() {
    const payload = JSON.stringify({ version: 1, grants: this.list() });
    const write = this.#writes
      .catch(() => {})
      .then(async () => {
        const temp = `${this.path}.${randomUUID()}.tmp`;
        const file = await open(
          temp,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(payload);
          await file.sync();
        } finally {
          await file.close();
        }
        try {
          await rename(temp, this.path);
        } finally {
          await unlink(temp).catch(() => {});
        }
      });
    this.#writes = write;
    return write;
  }
}
