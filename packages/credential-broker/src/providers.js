import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { BrokerError } from "./common.js";

function matchingHosts(record, site) {
  return [
    ...new Set(
      (record.login?.uris ?? []).flatMap(({ uri }) => {
        try {
          const url = new URL(uri);
          return ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            (url.hostname === site || (site.includes(".") && url.hostname.endsWith(`.${site}`)))
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

function run(executable, args, env, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { env, timeout, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // Never propagate raw CLI errors, stderr, arguments, or vault output.
        if (error) {
          let message =
            "Credential provider operation failed. Check vault login/unlock in the human terminal.";
          if (executable === "/usr/bin/osascript") {
            message = error.killed
              ? "Native vault unlock timed out. Enter your password in the dialog on the host Mac."
              : /\(-128\)/.test(stderr)
                ? "Native vault unlock was cancelled."
                : "Native vault unlock dialog failed. Run the broker from a human terminal with access to the host desktop.";
          } else if (error.code === "ENOENT") {
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
  constructor({ executable = "bw", runner = run, env = process.env, passwordPrompt } = {}) {
    this.executable = executable;
    this.runner = runner;
    this.env = { ...env };
    delete this.env.BW_SESSION;
    delete this.env.BW_PASSWORD;
    this.passwordPrompt =
      passwordPrompt ??
      (() => {
        if (process.platform !== "darwin")
          throw new BrokerError(
            "Native vault unlock currently requires macOS. Use demo mode on other platforms.",
          );
        return run(
          "/usr/bin/osascript",
          [
            "-e",
            'text returned of (display dialog "Unlock Bitwarden for Credential Broker" default answer "" with hidden answer buttons {"Cancel", "Unlock"} default button "Unlock")',
          ],
          this.env,
          120_000,
        );
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
  async search(site) {
    if (!this.#session) throw new BrokerError("Vault is locked.", 503);
    let records;
    try {
      // Desktop/web vault edits must reach the CLI cache before matching logins.
      await this.runner(this.executable, ["sync"], { ...this.env, BW_SESSION: this.#session });
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
    // Bitwarden returns full records. Retain only approval metadata, never fields.
    return records
      .flatMap((record) => {
        const hosts = matchingHosts(record, site);
        return record.type === 1 &&
          !record.deletedDate &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(record.id) &&
          hosts.length
          ? [{ item_id: record.id, name: String(record.name ?? "Login").slice(0, 120), hosts }]
          : [];
      })
      .slice(0, 100);
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
    }
  }
}
