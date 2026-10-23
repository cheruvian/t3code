import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { Broker } from "../src/broker.js";
import { BitwardenProvider, DemoProvider, DEMO_ITEM, DEMO_PASSWORD } from "../src/providers.js";
import { parseRequest } from "../src/common.js";

const input = {
  site: "https://example.com",
  field: "login",
  label: "Site login",
  reason: "Log in",
  ttl_seconds: 5,
};
const secondId = "22222222-2222-4222-8222-222222222222";
for (const { site, uri, matches } of [
  { site: "secure.chase.com", uri: "https://chase.com", matches: true },
  { site: "secure.chase.com", uri: "https://www.chase.com/login", matches: true },
  { site: "secure.chase.com", uri: "chase.com", matches: true },
  { site: "chase.com", uri: "https://secure.chase.com", matches: true },
  { site: "secure.chase.com", uri: "https://chase.com.evil.test", matches: false },
  { site: "secure.chase.com", uri: "https://evil-chase.com", matches: false },
  { site: "secure.chase.com", uri: "https://com", matches: false },
  { site: "secure.chase.com", uri: "https://user:password@chase.com", matches: false },
  { site: "login.bank.co.uk", uri: "https://bank.co.uk", matches: true },
  { site: "login.bank.co.uk", uri: "https://other.co.uk", matches: false },
  { site: "login.bank.co.uk", uri: "https://co.uk", matches: false },
  { site: "login.tenant.github.io", uri: "https://tenant.github.io", matches: true },
  { site: "tenant.github.io", uri: "https://other.github.io", matches: false },
  { site: "127.0.0.1", uri: "http://127.0.0.1/login", matches: true },
  { site: "127.0.0.1", uri: "http://127.0.0.2", matches: false },
]) {
  test(`${site} ${matches ? "matches" : "rejects"} saved URI ${uri} at search and delivery`, async () => {
    const record = {
      id: DEMO_ITEM,
      type: 1,
      name: "Fake login",
      login: { username: "fake-user", password: "fake-password", uris: [{ uri }] },
    };
    const calls = [];
    const provider = new BitwardenProvider({
      passwordPrompt: async () => "fake-master",
      runner: async (_, args) => {
        calls.push(args);
        return args[0] === "unlock"
          ? "fake-session"
          : args[0] === "list"
            ? JSON.stringify([record])
            : args[0] === "get"
              ? JSON.stringify(record)
              : "";
      },
    });
    await provider.initialize();
    try {
      const candidates = await provider.search(site);
      assert.equal(candidates.length, matches ? 1 : 0);
      assert.deepEqual(calls[2], ["list", "items", "--url", `https://${site}`, "--raw"]);
      if (matches) {
        assert.deepEqual(JSON.parse(await provider.get(DEMO_ITEM, "login", site)), {
          username: "fake-user",
          password: "fake-password",
        });
      } else {
        await assert.rejects(provider.get(DEMO_ITEM, "login", site), /invalid login/);
      }
    } finally {
      await provider.close();
    }
  });
}
test("local hostname search matches the exact host and excludes lookalikes", async () => {
  assert.equal(parseRequest({ ...input, site: "heihei" }).site, "heihei");
  for (const site of [
    "heihei:22",
    "heihei/path",
    "heihei..local",
    "-heihei",
    "https://user:password@heihei",
  ])
    assert.throws(() => parseRequest({ ...input, site }));
  const records = ["https://heihei", "https://heihei.evil.test", "https://other.heihei"].map(
    (uri, index) => ({
      id: index === 0 ? DEMO_ITEM : secondId,
      type: 1,
      name: "Test host",
      login: { username: "fake-user", password: "fake-password", uris: [{ uri }] },
    }),
  );
  const provider = new BitwardenProvider({
    passwordPrompt: async () => "fake-master",
    runner: async (_, args) =>
      args[0] === "unlock" ? "fake-session" : args[0] === "list" ? JSON.stringify(records) : "",
  });
  await provider.initialize();
  assert.deepEqual(await provider.search("heihei"), [
    { item_id: DEMO_ITEM, name: "Test host", hosts: ["heihei"] },
  ]);
  await provider.close();
});
async function setup(t, provider) {
  const runtime = await mkdtemp("/tmp/cb-search-");
  const broker = new Broker({ runtime, provider, watchdog: false });
  await broker.initialize();
  t.after(async () => {
    await broker.close();
    await rm(runtime, { recursive: true, force: true });
  });
  return broker;
}
async function ready(broker, id) {
  let result;
  do {
    await new Promise((resolve) => setImmediate(resolve));
    result = await broker.status(id);
  } while (result.state === "searching");
  return result;
}

test("site request searches at first access, only human sees choices, approval delivers both fields", async (t) => {
  const provider = new DemoProvider();
  let reads = 0;
  provider.search = async (site) => {
    assert.equal(site, "example.com");
    return [DEMO_ITEM, secondId].map((item_id) => ({
      item_id,
      name: "Matching login",
      hosts: [site],
    }));
  };
  const get = provider.get.bind(provider);
  provider.get = (...args) => {
    reads++;
    return get(...args);
  };
  const broker = await setup(t, provider);
  const request = broker.request(input);
  assert.equal(request.state, "searching");
  const pending = await ready(broker, request.request_id);
  assert.equal(pending.state, "pending");
  assert.equal(pending.candidates, undefined);
  assert.equal((await broker.list())[0].candidates.length, 2);
  assert.deepEqual(await readdir(broker.leaseDir), []);
  assert.equal(reads, 0);
  await assert.rejects(broker.decide(request.request_id, true), /Choose/);
  await assert.rejects(broker.decide(request.request_id, true, "unknown-id"), /Choose/);
  assert.equal(reads, 0);
  const active = await broker.decide(request.request_id, true, DEMO_ITEM);
  assert.deepEqual(JSON.parse(await readFile(active.path, "utf8")), {
    username: "demo@example.com",
    password: DEMO_PASSWORD,
  });
  assert.equal(reads, 1);
  assert.ok(!JSON.stringify(await broker.list()).includes(DEMO_PASSWORD));
  assert.ok(!JSON.stringify(await broker.list()).includes("demo@example.com"));
  await broker.release(request.request_id);
});

test("empty, failed, and cancelled searches never deliver files or resurrect requests", async (t) => {
  const provider = new DemoProvider();
  const broker = await setup(t, provider);
  const empty = broker.request({ ...input, site: "missing.example" });
  assert.equal((await ready(broker, empty.request_id)).state, "failed");
  provider.search = async () => {
    throw new Error(DEMO_PASSWORD);
  };
  const failed = broker.request(input);
  assert.ok(!JSON.stringify(await ready(broker, failed.request_id)).includes(DEMO_PASSWORD));
  let finish;
  provider.search = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const cancelled = broker.request(input);
  await broker.release(cancelled.request_id);
  finish([{ item_id: DEMO_ITEM, name: "Login", hosts: ["example.com"] }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await broker.status(cancelled.request_id)).state, "released");
  assert.deepEqual(await readdir(broker.leaseDir), []);
});

test("provider search strips credential fields and lookalikes, rechecks host at delivery", async () => {
  const calls = [];
  const record = (id, uri, extra = {}) => ({
    id,
    type: 1,
    name: "Example login",
    notes: "private-note",
    login: { username: "private-user", password: "private-pass", uris: [{ uri }] },
    ...extra,
  });
  let current = record(DEMO_ITEM, "https://accounts.example.com/login?private=token");
  const provider = new BitwardenProvider({
    passwordPrompt: async () => "fake-master",
    runner: async (_, args, env) => {
      calls.push(args);
      if (args[0] === "unlock") return "fake-session";
      assert.equal(env.BW_SESSION, "fake-session");
      if (args[0] === "list")
        return JSON.stringify([
          current,
          record(secondId, "https://example.com.evil.test"),
          record(secondId, "https://evil-example.com"),
          record(secondId, "https://example.com", { deletedDate: "today" }),
          record(secondId, "https://example.com", { type: 2 }),
          record(secondId, "https://u:p@example.com"),
        ]);
      return args[0] === "get" ? JSON.stringify(current) : "";
    },
  });
  await provider.initialize();
  const matches = await provider.search("example.com");
  assert.deepEqual(matches, [
    { item_id: DEMO_ITEM, name: "Example login", hosts: ["accounts.example.com"] },
  ]);
  assert.deepEqual(calls[1], ["sync"]);
  assert.deepEqual(calls[2], ["list", "items", "--url", "https://example.com", "--raw"]);
  assert.equal(
    await provider.get(DEMO_ITEM, "login", "example.com"),
    JSON.stringify({ username: "private-user", password: "private-pass" }),
  );
  current = record(DEMO_ITEM, "https://evil.test");
  await assert.rejects(provider.get(DEMO_ITEM, "login", "example.com"), /invalid login/);
  await provider.close();
});

test("request requires exactly one site or UUID and rejects non-origin sites", () => {
  assert.equal(parseRequest(input).site, "example.com");
  assert.equal(parseRequest({ ...input, site: "localhost" }).site, "localhost");
  for (const site of [
    "file:///tmp/vault",
    "https://u:p@example.com",
    "https://example.com/path",
    "https://example.com?token=secret",
    "https://example.com:8080",
    "bad_host",
  ])
    assert.throws(() => parseRequest({ ...input, site }), /Invalid request/);
  assert.throws(() => parseRequest({ ...input, item_id: DEMO_ITEM }), /Invalid request/);
  assert.throws(() => parseRequest({ ...input, site: undefined }), /Invalid request/);
});

test("concurrent searches share sync, reuse fresh vault data, and refresh after 30 seconds", async () => {
  let now = 0;
  let syncs = 0;
  let releaseSync;
  let syncStarted;
  const started = new Promise((resolve) => {
    syncStarted = resolve;
  });
  const blocked = new Promise((resolve) => {
    releaseSync = resolve;
  });
  const provider = new BitwardenProvider({
    now: () => now,
    passwordPrompt: async () => "fake-master",
    runner: async (_, args) => {
      if (args[0] === "unlock") return "fake-session";
      if (args[0] === "sync") {
        syncs++;
        syncStarted();
        await blocked;
        return "";
      }
      return "[]";
    },
  });
  await provider.initialize();
  const phases = [];
  const first = provider.search("example.com", (phase) => phases.push(phase));
  await started;
  const second = provider.search("example.org");
  assert.equal(syncs, 1);
  assert.deepEqual(phases, ["syncing"]);
  releaseSync();
  await Promise.all([first, second]);
  assert.deepEqual(phases, ["syncing", "matching"]);
  now = 29_999;
  await provider.search("example.com");
  assert.equal(syncs, 1);
  now = 30_000;
  await provider.search("example.com");
  assert.equal(syncs, 2);
  await provider.close();
});

test("a failed sync is retried by a new search instead of caching failure", async () => {
  let syncs = 0;
  const provider = new BitwardenProvider({
    passwordPrompt: async () => "fake-master",
    runner: async (_, args) => {
      if (args[0] === "unlock") return "fake-session";
      if (args[0] === "sync" && ++syncs === 1) throw new Error("withheld");
      return "[]";
    },
  });
  await provider.initialize();
  await assert.rejects(provider.search("example.com"), /Vault login search failed/);
  assert.deepEqual(await provider.search("example.com"), []);
  assert.equal(syncs, 2);
  await provider.close();
});
