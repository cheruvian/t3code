import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { getDomain } from "tldts";
import { BrokerError } from "./common.js";

function matchingHosts(record, site) {
  const domain = getDomain(site, { allowPrivateDomains: true });
  return [
    ...new Set(
      (record.login?.uris ?? []).flatMap(({ uri }) => {
        try {
          const url = new URL(uri.includes("://") ? uri : `https://${uri}`);
          return ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            (url.hostname === site ||
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
      { env, timeout, maxBuffer: 2 * 1024 * 1024 },
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
  #syncing;
  #syncedAt = -Infinity;
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
  async search(site, progress = () => {}) {
    if (!this.#session) throw new BrokerError("Vault is locked.", 503);
    let records;
    try {
      // Concurrent requests share one sync; a short freshness window avoids another
      // network round trip when the human requests a second login immediately.
      if (this.now() - this.#syncedAt >= 30_000) {
        progress("syncing");
        this.#syncing ??= this.runner(this.executable, ["sync"], {
          ...this.env,
          BW_SESSION: this.#session,
        })
          .then(() => {
            this.#syncedAt = this.now();
          })
          .finally(() => {
            this.#syncing = undefined;
          });
        await this.#syncing;
      }
      progress("matching");
      records = JSON.parse(
        await this.runner(this.executable, ["list", "items", "--url", `https://${site}`, "--raw"], {
          ...this.env,
          BW_SESSION: this.#session,
        }),
      );
      if (!Array.isArray(records)) throw new Error();
    } catch {
      throw new BrokerError("Vault login search failed.", 502);
    }
    // Retain only human approval metadata, never passwords, notes, or full URLs.
    return records
      .flatMap((record) => {
        const hosts = matchingHosts(record, site);
        return record.type === 1 &&
          !record.deletedDate &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(record.id) &&
          hosts.length
          ? [
              {
                item_id: record.id,
                name: String(record.name ?? "Login").slice(0, 120),
                hosts,
                ...(typeof record.login?.username === "string" && record.login.username
                  ? { username: record.login.username.slice(0, 320) }
                  : {}),
              },
            ]
          : [];
      })
      .slice(0, 100);
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
  async get(item, field, site) {
    if (!this.#session) throw new BrokerError("Vault is locked.", 503);
    const raw = await this.runner(this.executable, ["get", "item", item, "--raw"], {
      ...this.env,
      BW_SESSION: this.#session,
    });
    let record;
    try {
      record = JSON.parse(raw);
      if (record.id !== item || record.type !== 1) throw new Error();
      if (site && !matchingHosts(record, site).length) throw new Error();
    } catch {
      throw new BrokerError("Credential provider returned an invalid login item.", 502);
    }
    return loginValue(record, field);
  }
  async close() {
    if (!this.#session) return;
    try {
      await this.runner(this.executable, ["lock"], {
        ...this.env,
        BW_SESSION: this.#session,
      });
    } finally {
      this.#session = undefined;
      this.#syncedAt = -Infinity;
    }
  }
}
