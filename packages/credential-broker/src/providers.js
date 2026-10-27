import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { getDomain } from "tldts";
import { isIP } from "node:net";
import { BrokerError, siteHost } from "./common.js";

function matchingHosts(record, site) {
  const domain = site === undefined ? null : getDomain(site, { allowPrivateDomains: true });
  return [
    ...new Set(
      (record.login?.uris ?? []).flatMap(({ uri, match }) => {
        try {
          const url = new URL(uri.includes("://") ? uri : `https://${uri}`);
          return match !== 5 &&
            ["http:", "https:"].includes(url.protocol) &&
            !url.hostname.includes("*") &&
            !url.username &&
            !url.password &&
            (site === undefined ||
              url.hostname === site ||
              (domain !== null &&
                getDomain(url.hostname, { allowPrivateDomains: true }) === domain))
            ? [url.hostname]
            : [];
        } catch {
          return [];
        }
      }),
    ),
  ];
}

// SSH items have no login URIs. Explicit host bindings avoid offering a key to
// sibling domains or interpreting a vault item's display name as authorization.
function matchingSshHosts(record, site) {
  return [
    ...new Set(
      (record.fields ?? []).flatMap((field) => {
        if (field.type !== 0 || field.name !== "t3-ssh-hosts" || typeof field.value !== "string")
          return [];
        return field.value.split(/[\s,]+/).flatMap((host) => {
          try {
            const hostname = siteHost(host);
            return site === undefined || hostname === site ? [hostname] : [];
          } catch {
            return [];
          }
        });
      }),
    ),
  ];
}

function searchText(value) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
function queryTerms(query) {
  return query
    .trim()
    .split(/\s+/)
    .flatMap((part) => {
      try {
        if (part.includes("://") || part.includes("/"))
          part = new URL(part.includes("://") ? part : `https://${part}`).hostname;
      } catch {}
      return searchText(part).split(/\s+/).filter(Boolean);
    });
}
function hostMatches(host, site, ssh) {
  if (host.includes("*")) return false;
  if (host === site) return true;
  const domain = getDomain(site, { allowPrivateDomains: true });
  return !ssh && domain !== null && getDomain(host, { allowPrivateDomains: true }) === domain;
}
function matchingSshLoginHosts(record, site) {
  return (record.login?.uris ?? []).flatMap(({ uri, match }) => {
    try {
      const url = new URL(uri);
      return match !== 5 &&
        url.protocol === "ssh:" &&
        !url.hostname.includes("*") &&
        !url.password &&
        (site === undefined || hostMatches(url.hostname, site, false))
        ? [url.hostname]
        : [];
    } catch {
      return [];
    }
  });
}
function wildcardHost(value) {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (
      !["http:", "https:", "ssh:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !url.hostname.startsWith("*.")
    )
      return [];
    return [`*.${siteHost(url.hostname.slice(2))}`];
  } catch {
    return [];
  }
}
function wildcardHosts(record) {
  const values =
    record.type === 5
      ? (record.fields ?? [])
          .filter(
            (field) =>
              field.name === "t3-ssh-hosts" && field.type === 0 && typeof field.value === "string",
          )
          .flatMap((field) => field.value.split(/[\s,]+/))
      : (record.login?.uris ?? []).filter((uri) => uri.match !== 5).map((uri) => uri.uri);
  return [...new Set(values.flatMap(wildcardHost))];
}
function shortHostMatch(host, site) {
  if (host.includes("*") || isIP(host) || isIP(site)) return false;
  return host.includes(".") !== site.includes(".") && host.split(".")[0] === site.split(".")[0];
}
function wildcardMatches(pattern, site) {
  return site !== pattern.slice(2) && site.endsWith(`.${pattern.slice(2)}`);
}
function metadata(record) {
  if (
    ![1, 5].includes(record.type) ||
    record.deletedDate ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(record.id)
  )
    return [];
  const ssh = record.type === 5;
  return [
    {
      item_id: record.id,
      kind: ssh ? "sshKey" : "login",
      name: String(record.name ?? (ssh ? "SSH key" : "Login")).slice(0, 120),
      hosts: ssh ? matchingSshHosts(record) : matchingHosts(record),
      sshHosts: matchingSshLoginHosts(record),
      wildcardHosts: wildcardHosts(record),
      ...(!ssh && typeof record.login?.username === "string" && record.login.username
        ? { username: record.login.username.slice(0, 320) }
        : {}),
    },
  ];
}

function loginValue(record, field) {
  const login = record.login;
  if (field === "login") {
    if (
      ![login?.username, login?.password].every(
        (value) => typeof value === "string" && value.length,
      )
    )
      throw new BrokerError("Requested login fields are empty.", 422);
    return JSON.stringify({ username: login.username, password: login.password });
  }
  const value = login?.[field];
  if (typeof value !== "string" || !value.length)
    throw new BrokerError("Requested login field is empty.", 422);
  return value;
}

export const DEMO_ITEM = "11111111-1111-4111-8111-111111111111";
export const DEMO_PASSWORD = "demo-only-password-not-a-real-credential";

function run(executable, args, env, timeout = 30_000, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      args,
      {
        env,
        timeout,
        // Full-vault listings include more than the URL-filtered login subset.
        maxBuffer: (args[0] === "list" && !args.includes("--url") ? 16 : 2) * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        // Never propagate raw CLI errors, stderr, arguments, or vault output.
        if (error) {
          let message =
            "Credential provider operation failed. Check vault login/unlock in the human terminal.";
          if (error.code === "ENOENT") {
            message = "Bitwarden CLI executable was not found.";
          } else if (args[0] === "unlock") {
            message = error.killed
              ? "Bitwarden vault unlock timed out."
              : /invalid (master )?password/i.test(stderr)
                ? "Bitwarden did not accept the master password."
                : "Bitwarden vault unlock failed. Confirm CLI login and unlock in a human terminal.";
          }
          reject(new BrokerError(message, 502));
        } else resolve(stdout);
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export class DemoProvider {
  mode = "demo";
  async initialize() {}
  async search(site) {
    return site === "example.com"
      ? [{ item_id: DEMO_ITEM, name: "Demo login", hosts: [site] }]
      : [];
  }
  async get(item, field) {
    if (item !== DEMO_ITEM) throw new BrokerError("Demo item not found.", 404);
    return loginValue({ login: { username: "demo@example.com", password: DEMO_PASSWORD } }, field);
  }
  async close() {}
}

export class BitwardenProvider {
  mode = "bitwarden";
  #session;
  #syncedAt = -Infinity;
  #index;
  #loading;
  #generation = 0;
  constructor({
    executable = "bw",
    runner = run,
    env = process.env,
    passwordPrompt,
    now = Date.now,
  } = {}) {
    this.now = now;
    this.executable = executable;
    this.runner = runner;
    this.env = { ...env };
    delete this.env.BW_SESSION;
    delete this.env.BW_PASSWORD;
    this.passwordPrompt =
      passwordPrompt ??
      (() => {
        throw new BrokerError("Unlock the vault through Credential access in T3.");
      });
  }
  async initialize() {
    let master = await this.passwordPrompt();
    master = master.replace(/\r?\n$/, "");
    const key = `CB_UNLOCK_${randomBytes(12).toString("hex")}`;
    try {
      this.#session = (
        await this.runner(this.executable, ["unlock", "--raw", "--passwordenv", key], {
          ...this.env,
          [key]: master,
        })
      ).trim();
      if (!this.#session) throw new BrokerError("Vault unlock did not return a session.", 502);
    } finally {
      master = undefined;
    }
  }
  invalidateIndex() {
    this.#generation++;
    this.#index = undefined;
    this.#loading = undefined;
  }
  async index(progress) {
    if (!this.#session) throw new BrokerError("Vault is locked.", 503);
    if (this.#index && this.now() - this.#syncedAt < 30_000)
      return { items: this.#index, cacheHit: true };
    const generation = this.#generation;
    const session = this.#session;
    progress("syncing");
    this.#loading ??= (async () => {
      await this.runner(this.executable, ["sync"], { ...this.env, BW_SESSION: session });
      const records = JSON.parse(
        await this.runner(this.executable, ["list", "items", "--raw"], {
          ...this.env,
          BW_SESSION: session,
        }),
      );
      if (!Array.isArray(records) || generation !== this.#generation || session !== this.#session)
        throw new Error();
      const items = records.flatMap(metadata);
      this.#index = items;
      this.#syncedAt = this.now();
      return items;
    })().finally(() => {
      if (generation === this.#generation) this.#loading = undefined;
    });
    return { items: await this.#loading, cacheHit: false };
  }
  async search(site, progress = () => {}, field = "password", query) {
    const started = this.now();
    const generation = this.#generation;
    try {
      const { items, cacheHit } = await this.index(progress);
      if (generation !== this.#generation || !this.#session) throw new Error();
      progress("matching");
      const compatible = items.filter(
        (item) => field === "ssh" || item.kind === (field === "sshKey" ? "sshKey" : "login"),
      );
      const terms = query === undefined ? null : queryTerms(query);
      const alias = (getDomain(site, { allowPrivateDomains: true }) ?? site).split(".")[0];
      let hostMatchesCount = 0;
      let suggestedCount = 0;
      const ranked = compatible
        .flatMap((item) => {
          const allHosts = [...new Set([...item.hosts, ...item.sshHosts, ...item.wildcardHosts])];
          const bindings = field === "ssh" ? allHosts : item.hosts;
          const hosts = bindings.filter((host) => hostMatches(host, site, item.kind === "sshKey"));
          if (hosts.length) hostMatchesCount++;
          const name = searchText(item.name);
          const text = searchText([item.name, item.username ?? "", ...allHosts].join(" "));
          const nameMatch = name.split(" ").includes(alias);
          const matchReason = allHosts.some((host) => shortHostMatch(host, site))
            ? "shortHost"
            : item.wildcardHosts.some((pattern) => wildcardMatches(pattern, site))
              ? "wildcard"
              : undefined;
          if (!hosts.length && (nameMatch || matchReason)) suggestedCount++;
          if (
            terms === null
              ? !hosts.length && !nameMatch && !matchReason
              : !terms.every((term) => text.includes(term))
          )
            return [];
          const score =
            (hosts.includes(site) ? 1000 : hosts.length ? 800 : 0) +
            (terms?.length && searchText(item.name) === terms.join(" ") ? 400 : 0) +
            (matchReason === "shortHost" ? 600 : matchReason === "wildcard" ? 500 : 0) +
            (nameMatch ? 100 : 0) +
            (terms?.filter((term) => name.includes(term)).length ?? 0);
          return [
            {
              score,
              candidate: {
                item_id: item.item_id,
                name: item.name,
                hosts: query === undefined && hosts.length ? hosts : allHosts,
                ...(item.username ? { username: item.username } : {}),
                ...(field === "ssh" ? { kind: item.kind } : {}),
                ...(!hosts.length
                  ? { hostMismatch: true, ...(matchReason ? { matchReason } : {}) }
                  : {}),
              },
            },
          ];
        })
        .sort(
          (a, b) =>
            b.score - a.score ||
            a.candidate.name.localeCompare(b.candidate.name) ||
            a.candidate.item_id.localeCompare(b.candidate.item_id),
        );
      const results = ranked.slice(0, 100).map((entry) => entry.candidate);
      Object.defineProperty(results, "diagnostics", {
        value: {
          indexedItems: items.length,
          compatibleItems: compatible.length,
          hostMatches: hostMatchesCount,
          suggestedMatches: suggestedCount,
          returnedItems: results.length,
          truncated: ranked.length > 100,
          cacheHit,
          durationMs: Math.max(0, this.now() - started),
        },
      });
      return results;
    } catch {
      throw new BrokerError("Vault credential search failed.", 502);
    }
  }
  async searchVault(site, query, field, progress) {
    return this.search(site, progress, field, query);
  }
  async create(site, { username, password }) {
    if (!this.#session) throw new BrokerError("Vault is locked.", 503);
    const item = {
      type: 1,
      name: username ? `${site} (${username})` : site,
      favorite: false,
      reprompt: 0,
      login: { username, password, uris: [{ uri: `https://${site}`, match: 0 }] },
    };
    this.invalidateIndex();
    try {
      // stdin keeps even the encoded login out of process arguments and logs.
      const raw = await this.runner(
        this.executable,
        ["create", "item"],
        { ...this.env, BW_SESSION: this.#session },
        30_000,
        Buffer.from(JSON.stringify(item)).toString("base64"),
      );
      const record = JSON.parse(raw);
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(record.id) ||
        record.type !== 1 ||
        !matchingHosts(record, site).length
      )
        throw new Error();
      this.invalidateIndex();
      return {
        item_id: record.id,
        name: item.name,
        hosts: [site],
        ...(username ? { username: username.slice(0, 320) } : {}),
      };
    } catch {
      throw new BrokerError(
        "Could not confirm the saved login. Check Bitwarden before retrying.",
        502,
      );
    }
  }
  async addHost(item, field, site) {
    if (!this.#session) throw new BrokerError("Vault is locked.", 503);
    this.invalidateIndex();
    try {
      site = siteHost(site);
      const env = { ...this.env, BW_SESSION: this.#session };
      const record = JSON.parse(
        await this.runner(this.executable, ["get", "item", item, "--raw"], env),
      );
      if (field === "ssh") field = record.type === 5 ? "sshKey" : "login";
      const valid = (value) =>
        value.id === item && !value.deletedDate && value.type === (field === "sshKey" ? 5 : 1);
      if (!valid(record)) throw new Error();
      const hosts = (value) =>
        field === "sshKey" ? matchingSshHosts(value) : matchingHosts(value);
      if (!hosts(record).includes(site)) {
        if (field === "sshKey") {
          record.fields ??= [];
          const binding = record.fields.find(
            (entry) => entry.name === "t3-ssh-hosts" && entry.type === 0,
          );
          if (binding) binding.value = [binding.value, site].filter(Boolean).join("\n");
          else record.fields.push({ name: "t3-ssh-hosts", type: 0, value: site });
        } else {
          record.login ??= {};
          record.login.uris ??= [];
          record.login.uris.push({ uri: `https://${site}`, match: 0 });
        }
        const saved = JSON.parse(
          await this.runner(
            this.executable,
            ["edit", "item", item],
            env,
            30_000,
            Buffer.from(JSON.stringify(record)).toString("base64"),
          ),
        );
        if (!valid(saved) || !hosts(saved).includes(site)) throw new Error();
        this.invalidateIndex();
        return { hosts: hosts(saved) };
      }
      return { hosts: hosts(record) };
    } catch {
      throw new BrokerError("Could not confirm the saved host in Bitwarden.", 502);
    }
  }
  async get(item, field, site, { allowHostMismatch = false } = {}) {
    if (!this.#session) throw new BrokerError("Vault is locked.", 503);
    const raw = await this.runner(this.executable, ["get", "item", item, "--raw"], {
      ...this.env,
      BW_SESSION: this.#session,
    });
    let record;
    try {
      record = JSON.parse(raw);
      if (
        record.id !== item ||
        record.deletedDate ||
        (field === "ssh"
          ? ![1, 5].includes(record.type)
          : record.type !== (field === "sshKey" ? 5 : 1))
      )
        throw new Error();
      if (site && !allowHostMismatch) {
        const hosts =
          record.type === 5
            ? matchingSshHosts(record, site)
            : [
                ...matchingHosts(record, site),
                ...(field === "ssh" ? matchingSshLoginHosts(record, site) : []),
              ];
        if (!hosts.length) throw new Error();
      }
    } catch {
      throw new BrokerError(
        field === "sshKey"
          ? "Credential provider returned an invalid SSH key item."
          : "Credential provider returned an invalid login item.",
        502,
      );
    }
    if (field === "sshKey" || (field === "ssh" && record.type === 5)) {
      const key = record.sshKey?.privateKey;
      if (typeof key !== "string" || !key.trim())
        throw new BrokerError("Requested SSH private key is empty.", 422);
      const privateKey = key.endsWith("\n") ? key : `${key}\n`;
      return field === "ssh" ? JSON.stringify({ type: "sshKey", privateKey }) : privateKey;
    }
    return field === "ssh"
      ? JSON.stringify({ type: "login", ...JSON.parse(loginValue(record, "login")) })
      : loginValue(record, field);
  }
  async close() {
    this.#generation++;
    this.#index = undefined;
    this.#loading = undefined;
    const session = this.#session;
    this.#session = undefined;
    if (!session) return;
    try {
      await this.runner(this.executable, ["lock"], {
        ...this.env,
        BW_SESSION: session,
      });
    } finally {
      this.#session = undefined;
      this.#syncedAt = -Infinity;
    }
  }
}
