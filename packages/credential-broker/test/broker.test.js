import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { Broker } from "../src/broker.js";
import { DemoProvider, DEMO_ITEM, DEMO_PASSWORD } from "../src/providers.js";

const input = {
  item_id: DEMO_ITEM,
  label: "Demo login",
  reason: "Test a temporary credential file",
  ttl_seconds: 5,
};
async function setup(t, provider = new DemoProvider(), options = {}) {
  const runtime = await mkdtemp("/tmp/cb-unit-");
  const broker = new Broker({ runtime, provider, watchdog: false, ...options });
  await broker.initialize();
  t.after(async () => {
    await broker.close();
    await rm(runtime, { recursive: true, force: true });
  });
  return broker;
}
function noSecret(value) {
  assert.ok(!JSON.stringify(value).includes(DEMO_PASSWORD));
}

test("no provider fetch or file before approval; approved file is private and results are secret-free", async (t) => {
  let reads = 0;
  const provider = new DemoProvider();
  const get = provider.get.bind(provider);
  provider.get = async (...args) => {
    reads++;
    return get(...args);
  };
  const broker = await setup(t, provider);
  const pending = broker.request(input);
  assert.equal(pending.state, "pending");
  assert.equal(reads, 0);
  assert.deepEqual(await readdir(broker.leaseDir), []);
  const active = await broker.decide(pending.request_id, true);
  assert.equal(active.state, "active");
  assert.equal(reads, 1);
  assert.equal(await readFile(active.path, "utf8"), DEMO_PASSWORD);
  assert.equal((await stat(active.path)).mode & 0o777, 0o600);
  assert.equal((await stat(broker.leaseDir)).mode & 0o777, 0o700);
  noSecret(pending);
  noSecret(active);
  noSecret(await broker.list());
  await assert.rejects(broker.decide(pending.request_id, true), /no longer/);
  assert.equal(reads, 1);
});

test("denial and pending approval timeout never fetch a secret", async (t) => {
  let reads = 0;
  let now = 10_000;
  const provider = new DemoProvider();
  provider.get = async () => {
    reads++;
    return DEMO_PASSWORD;
  };
  const broker = await setup(t, provider, {
    now: () => now,
    approvalTimeout: 100,
  });
  const denied = broker.request(input);
  assert.equal((await broker.decide(denied.request_id, false)).state, "denied");
  const expired = broker.request(input);
  now += 101;
  assert.equal((await broker.status(expired.request_id)).state, "expired");
  await assert.rejects(broker.decide(expired.request_id, true), /no longer/);
  assert.equal(reads, 0);
  assert.deepEqual(await readdir(broker.leaseDir), []);
});

test("file expiry and explicit release remove paths and stop returning them", async (t) => {
  let now = 10_000;
  const broker = await setup(t, undefined, { now: () => now });
  const active = await broker.decide(broker.request(input).request_id, true);
  now += 5_000;
  const expired = await broker.status(active.request_id);
  assert.equal(expired.state, "expired");
  assert.equal(expired.path, undefined);
  await assert.rejects(stat(active.path), { code: "ENOENT" });
  const next = await broker.decide(broker.request(input).request_id, true);
  assert.equal((await broker.release(next.request_id)).state, "released");
  await assert.rejects(stat(next.path), { code: "ENOENT" });
  assert.equal((await broker.release(next.request_id)).state, "released");
});

test("release during credential retrieval cancels delivery", async (t) => {
  let resolve;
  const provider = new DemoProvider();
  provider.get = () =>
    new Promise((r) => {
      resolve = r;
    });
  const broker = await setup(t, provider);
  const request = broker.request(input);
  const approval = broker.decide(request.request_id, true);
  while (!resolve) await new Promise((r) => setImmediate(r));
  await broker.release(request.request_id);
  resolve(DEMO_PASSWORD);
  assert.equal((await approval).state, "released");
  assert.deepEqual(await readdir(broker.leaseDir), []);
});

test("provider failures are sanitized and do not produce files", async (t) => {
  const provider = new DemoProvider();
  provider.get = async () => {
    throw new Error(DEMO_PASSWORD);
  };
  const broker = await setup(t, provider);
  const failed = await broker.decide(broker.request(input).request_id, true);
  assert.equal(failed.state, "failed");
  noSecret(failed);
  assert.deepEqual(await readdir(broker.leaseDir), []);
});

test("reject unsafe requests, symlink runtime, and an already-running broker", async (t) => {
  const broker = await setup(t);
  for (const bad of [
    { ...input, ttl_seconds: 0 },
    { ...input, ttl_seconds: 301 },
    { ...input, item_id: "../vault" },
    { ...input, path: "/tmp/leak" },
    { ...input, field: "notes" },
  ]) {
    assert.throws(() => broker.request(bad), /Invalid request/);
  }
  const second = new Broker({
    runtime: broker.runtime,
    provider: new DemoProvider(),
  });
  await assert.rejects(second.initialize(), /already owns/);
  const parent = await mkdtemp("/tmp/cb-symlink-");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const path = join(parent, "link");
  await symlink(broker.runtime, path);
  await assert.rejects(
    new Broker({ runtime: path, provider: new DemoProvider() }).initialize(),
    /non-symlink/,
  );
});

test("restart clears orphan leases but leaves unrelated files untouched", async (t) => {
  const broker = await setup(t);
  const file = join(broker.leaseDir, "lease-22222222-2222-4222-8222-222222222222.secret");
  const unrelated = join(broker.leaseDir, "leave-this-file");
  await broker.close();
  await writeFile(file, DEMO_PASSWORD, { mode: 0o600 });
  await writeFile(unrelated, "not-a-lease");
  await broker.initialize();
  await assert.rejects(stat(file), { code: "ENOENT" });
  assert.equal(await readFile(unrelated, "utf8"), "not-a-lease");
});

test("concurrent releases await credential deletion and supervisor exit", async (t) => {
  const broker = await setup(t);
  const pending = broker.request(input);
  await broker.decide(pending.request_id, true);
  const request = broker.find(pending.request_id);
  let finish;
  request.runnerExit = new Promise((resolve) => {
    finish = resolve;
  });
  const first = broker.release(request.request_id);
  let secondCompleted = false;
  const second = broker.release(request.request_id).then(() => {
    secondCompleted = true;
  });
  let completed = false;
  const joined = Promise.all([first, second]).then(() => {
    completed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondCompleted, false);
  assert.equal(completed, false);
  finish();
  await joined;
  assert.equal(broker.public(request, true).settled, true);
  await assert.rejects(stat(request.path), { code: "ENOENT" });
});

test("cleanup failure settles as failed", async (t) => {
  const broker = await setup(t);
  const pending = broker.request(input);
  await broker.decide(pending.request_id, true);
  const request = broker.find(pending.request_id);
  const remove = broker.remove;
  broker.remove = async () => {
    throw new Error("fake cleanup failure");
  };
  await assert.rejects(broker.release(request.request_id), /fake cleanup failure/);
  assert.equal(broker.public(request, true).settled, true);
  assert.equal(request.state, "failed");
  broker.remove = remove;
  request.cleanupPromise = undefined;
  await broker.remove(request);
});
