import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { Broker } from "../src/broker.js";
import { DemoProvider, DEMO_ITEM } from "../src/providers.js";
import { approvalPayload } from "../src/native-approval.js";

const input = {
  site: "example.com",
  label: "Native test",
  field: "login",
  reason: "Use login",
  ttl_seconds: 5,
};
async function setup(t, approver, extra = {}) {
  const runtime = await mkdtemp("/tmp/cb-native-");
  const provider = new DemoProvider();
  let reads = 0;
  const get = provider.get.bind(provider);
  provider.get = (...args) => {
    reads++;
    return get(...args);
  };
  const broker = new Broker({ runtime, provider, approver, watchdog: false, ...extra });
  await broker.initialize();
  t.after(async () => {
    await broker.close();
    await rm(runtime, { recursive: true, force: true });
  });
  return { broker, reads: () => reads };
}
async function until(condition) {
  for (let i = 0; i < 100; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Expected state did not arrive");
}

test("native prompt automatically receives search choices and gates delivery; denial/failure never read credentials", async (t) => {
  let decide;
  const { broker, reads } = await setup(t, async (request) => {
    assert.equal(request.candidates[0].item_id, DEMO_ITEM);
    return new Promise((resolve) => {
      decide = resolve;
    });
  });
  const request = broker.request(input);
  await until(() => !!decide);
  assert.equal(reads(), 0);
  assert.deepEqual(await readdir(broker.leaseDir), []);
  decide({ approve: true, item_id: DEMO_ITEM });
  await until(async () => (await broker.status(request.request_id)).state === "active");
  assert.equal(reads(), 1);
  await broker.release(request.request_id);
  broker.approver = async () => ({ approve: false });
  const denied = broker.request(input);
  await until(async () => (await broker.status(denied.request_id)).state === "denied");
  broker.approver = async () => {
    throw new Error("private-native-error");
  };
  const failed = broker.request(input);
  await until(async () => (await broker.status(failed.request_id)).state === "failed");
  assert.ok(
    !JSON.stringify(await broker.status(failed.request_id)).includes("private-native-error"),
  );
  assert.equal(reads(), 1);
});

test("queued native prompts serialize, release/expiry abort current dialog, stale approval cannot deliver", async (t) => {
  let now = Date.now();
  const prompts = [];
  const { broker, reads } = await setup(
    t,
    (request, { signal }) =>
      new Promise((resolve) => {
        prompts.push({ request, signal, resolve });
      }),
    { now: () => now },
  );
  const first = broker.request(input);
  const second = broker.request(input);
  await until(() => prompts.length === 1);
  await broker.release(first.request_id);
  assert.equal(prompts[0].signal.aborted, true);
  prompts[0].resolve({ approve: true, item_id: DEMO_ITEM });
  await until(() => prompts.length === 2);
  now += 120001;
  await broker.sweep();
  assert.equal(prompts[1].signal.aborted, true);
  prompts[1].resolve({ approve: true, item_id: DEMO_ITEM });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await broker.status(first.request_id)).state, "released");
  assert.equal((await broker.status(second.request_id)).state, "expired");
  assert.equal(reads(), 0);
  assert.deepEqual(await readdir(broker.leaseDir), []);
});

test("native review includes complete command metadata, oversized descriptions fail closed", () => {
  const request = {
    ...input,
    kind: "exec",
    client: "test agent",
    argv: ["/usr/bin/program", 'a"\\n$(fake)'],
    cwd: "/tmp",
    file_env: "CB_CREDENTIAL_FILE",
    candidates: [{ item_id: DEMO_ITEM, name: "Demo", hosts: ["example.com"] }],
  };
  const payload = approvalPayload(request);
  assert.match(payload.details, /username and password/);
  assert.ok(payload.details.includes(JSON.stringify(request.argv.slice(1))));
  assert.ok(payload.choices[0].label.includes(DEMO_ITEM));
  assert.throws(
    () => approvalPayload({ ...request, argv: ["/usr/bin/program", "x".repeat(9000)] }),
    /too large/,
  );
});
