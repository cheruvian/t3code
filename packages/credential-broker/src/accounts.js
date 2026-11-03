import { createHash } from "node:crypto";
import { BrokerError } from "./common.js";

export class AccountProvider {
  mode = "bitwarden";
  #providers = new Map();
  #items = new Map();
  #identities = new Map();
  get accounts() {
    return [...this.#providers.keys()];
  }
  async initialize() {}
  async add(account, provider, identity = account) {
    if (this.#providers.has(account)) throw new BrokerError("Account is already unlocked.");
    try {
      await provider.initialize();
      this.#providers.set(account, provider);
      this.#identities.set(account, identity);
      provider.warm?.();
    } catch (error) {
      await provider.close().catch(() => {});
      throw error;
    }
  }
  #candidate(account, candidate) {
    const hash = createHash("sha256")
      .update(JSON.stringify([this.#identities.get(account), candidate.item_id]))
      .digest("hex")
      .slice(0, 32);
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
    this.#items.set(id, { account, item: candidate.item_id });
    return { ...candidate, item_id: id, name: `${candidate.name} (${account})` };
  }
  #resolve(id) {
    try {
      const { account, item } = this.#items.get(id) ?? {};
      const provider = this.#providers.get(account);
      if (!provider || typeof item !== "string") throw new Error();
      return { provider, item };
    } catch {
      throw new BrokerError("Credential account is unavailable.");
    }
  }
  async refresh() {
    await Promise.all([...this.#providers.values()].map((provider) => provider.refresh?.()));
  }
  async #search(run) {
    const providers = [...this.#providers];
    const results = await Promise.all(
      providers.map(async ([account, provider]) => {
        const candidates = await run(provider);
        if (this.#providers.get(account) !== provider) throw new BrokerError("Vault is locked.");
        return candidates.map((candidate) => this.#candidate(account, candidate));
      }),
    );
    return results.flat();
  }
  search(site, progress, field) {
    return this.#search((provider) => provider.search(site, progress, field));
  }
  searchVault(site, query, field, progress) {
    return this.#search((provider) => provider.searchVault(site, query, field, progress));
  }
  async get(id, ...args) {
    const { provider, item } = this.#resolve(id);
    return provider.get(item, ...args);
  }
  async addHost(id, ...args) {
    const { provider, item } = this.#resolve(id);
    return provider.addHost(item, ...args);
  }
  async create(site, login) {
    if (!login.account && this.#providers.size !== 1)
      throw new BrokerError("Choose an account before saving.");
    const account = login.account ?? this.accounts[0];
    const provider = this.#providers.get(account);
    if (!provider) throw new BrokerError("Choose an unlocked account.");
    return this.#candidate(account, await provider.create(site, login));
  }
  async close() {
    const providers = [...this.#providers.values()];
    this.#providers.clear();
    this.#items.clear();
    this.#identities.clear();
    const results = await Promise.allSettled(providers.map((provider) => provider.close()));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }
}
