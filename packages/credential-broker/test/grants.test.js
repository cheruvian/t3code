import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Broker } from "../src/broker.js";
import { startServers } from "../src/server.js";
import { DemoProvider, DEMO_ITEM, DEMO_PASSWORD } from "../src/providers.js";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
async function until(fn) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Expected grant behavior did not arrive");
}
class Notifications {
  shown = [];
  dismissed = [];
  updated = [];
  async show(notice, action) {
    this.shown.push({ notice, action });
  }
  dismiss(id) {
    this.dismissed.push(id);
  }
  update(notice) {
    this.updated.push(notice);
  }
  close() {}
}
async function setup(t, extra = {}) {
  const runtime = await mkdtemp("/tmp/cb-grants-");
  const script = join(runtime, "task.mjs");
  const marker = join(runtime, "program.json");
  await writeFile(
    script,
    'import fs from "node:fs"; fs.writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,path:process.env.CB_CREDENTIAL_FILE}));setInterval(()=>{},1000);',
  );
  const notifier = new Notifications();
  const broker = new Broker({
    runtime,
    provider: new DemoProvider(),
    watchdog: false,
    notifier,
    ...extra,
  });
  await broker.initialize();
  const input = {
    kind: "exec",
    site: "example.com",
    field: "login",
    label: "Grant demo",
    reason: "Run test",
    client: "CLI agent (unverified)",
    ttl_seconds: 30,
    argv: [process.execPath, script, marker],
    cwd: runtime,
    file_env: "CB_CREDENTIAL_FILE",
  };
  t.after(async () => {
    await broker.close();
    await rm(runtime, { recursive: true, force: true });
  });
  return { broker, runtime, input, notifier, script, marker };
}
async function pending(broker, input) {
  const request = broker.request(input);
  await until(async () => (await broker.status(request.request_id)).state === "pending");
  return request;
}
async function allow(broker, input) {
  const request = await pending(broker, input);
  const allowed = await broker.decide(request.request_id, true, DEMO_ITEM, true);
  assert.equal(allowed.state, "running");
  await broker.release(request.request_id);
  return allowed.grant_id;
}

test("always allow persists without credentials and only the selected exact command auto-approves", async (t) => {
  const { broker, input, runtime, notifier, script } = await setup(t);
  const grantId = await allow(broker, input);
  const stored = await readFile(join(runtime, "grants.json"), "utf8");
  assert.ok(!stored.includes(DEMO_PASSWORD));
  assert.ok(!stored.includes("demo@example.com"));
  assert.equal((await stat(join(runtime, "grants.json"))).mode & 0o777, 0o600);
  const automatic = broker.request(input);
  await until(async () => (await broker.status(automatic.request_id)).state === "running");
  assert.equal((await broker.status(automatic.request_id)).auto_approved, true);
  assert.equal((await broker.status(automatic.request_id)).grant_id, grantId);
  assert.equal(notifier.shown.length, 1);
  await broker.release(automatic.request_id);
  for (const changed of [
    { client: "different caller" },
    { field: "password" },
    { ttl_seconds: 31 },
    { argv: [...input.argv, "extra"] },
  ]) {
    const request = await pending(broker, { ...input, ...changed });
    await broker.release(request.request_id);
  }
  await writeFile(script, "setInterval(()=>{},1000); // changed command bytes");
  const changedScript = await pending(broker, input);
  assert.equal(notifier.shown.length, 1);
  await broker.release(changedScript.request_id);
});

test("grant survives broker restart and revoked grant does not", async (t) => {
  let restarted;
  t.after(async () => {
    await restarted?.close();
  });
  const { broker, input, runtime, notifier } = await setup(t);
  const id = await allow(broker, input);
  await broker.close();
  restarted = new Broker({ runtime, provider: new DemoProvider(), watchdog: false, notifier });
  await restarted.initialize();
  const request = restarted.request(input);
  await until(async () => (await restarted.status(request.request_id)).state === "running");
  assert.equal((await restarted.status(request.request_id)).grant_id, id);
  await restarted.revokeGrant(id);
  assert.equal((await restarted.status(request.request_id)).state, "revoked");
  assert.equal(JSON.parse(await readFile(join(runtime, "grants.json"), "utf8")).grants.length, 0);
});

test("toast lasts 300 seconds after command exit; dismissal retains grant; expiry clears notice", async (t) => {
  let now = Date.now();
  const { broker, input, notifier } = await setup(t, { now: () => now });
  const id = await allow(broker, input);
  const first = broker.request(input);
  await until(() => notifier.shown.length === 1);
  const notice = notifier.shown[0].notice;
  assert.equal(notice.expires_at - notice.created_at, 300000);
  await until(async () => (await broker.status(first.request_id)).state === "running");
  await broker.release(first.request_id);
  now = notice.created_at + 299999;
  await broker.sweep();
  assert.equal(broker.notices().length, 1);
  now++;
  await broker.sweep();
  assert.equal(broker.notices().length, 0);
  assert.ok(notifier.dismissed.includes(notice.notice_id));
  const second = broker.request(input);
  await until(() => notifier.shown.length === 2);
  notifier.shown[1].action("dismiss");
  assert.equal(broker.notices().length, 0);
  assert.ok(broker.grants.get(id));
});

test("notification failure requires manual approval and presenter crash stops active auto use", async (t) => {
  const { broker, input, notifier } = await setup(t);
  const id = await allow(broker, input);
  notifier.show = async () => {
    throw new Error("private-presenter-error");
  };
  const manual = await pending(broker, input);
  assert.equal((await broker.status(manual.request_id)).auto_approved, undefined);
  assert.deepEqual(await readdir(broker.leaseDir), []);
  await broker.release(manual.request_id);
  notifier.show = Notifications.prototype.show;
  const request = broker.request(input);
  await until(async () => (await broker.status(request.request_id)).state === "running");
  notifier.shown[0].action("failed");
  await until(async () => (await broker.status(request.request_id)).state === "revoked");
  assert.ok(broker.grants.get(id));
});

test("presenter startup delay does not reduce the five-minute visible lifetime", async (t) => {
  let now = Date.now();
  const { broker, input, notifier } = await setup(t, { now: () => now });
  await allow(broker, input);
  const beforeStartup = now;
  notifier.show = async function (notice, action) {
    now += 4000;
    this.shown.push({ notice, action });
  };
  const request = broker.request(input);
  await until(async () => (await broker.status(request.request_id)).state === "running");
  const notice = broker.notices()[0];
  assert.equal(notice.created_at, beforeStartup + 4000);
  assert.equal(notice.expires_at, beforeStartup + 304000);
});

test("one-click revoke interrupts actual waiting CLI and supervised caller, removes file, prevents next automatic use", async (t) => {
  const { broker, input, runtime, notifier, marker } = await setup(t);
  const id = await allow(broker, input);
  await rm(marker, { force: true });
  const server = await startServers(broker, {
    port: 0,
    host: "127.0.0.1",
    publicUrl: "http://test.invalid",
  });
  t.after(() => server.close());
  const execution = execute(
    process.execPath,
    [
      cli,
      "exec",
      "--runtime",
      runtime,
      "--site",
      "example.com",
      "--field",
      "login",
      "--label",
      input.label,
      "--reason",
      input.reason,
      "--ttl",
      "30",
      "--cwd",
      runtime,
      "--",
      ...input.argv,
    ],
    { timeout: 10000 },
  ).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await until(() => notifier.shown.length === 1);
  const notice = notifier.shown[0];
  await until(async () => (await broker.status(notice.notice.request_id)).state === "running");
  const details = await until(async () => {
    try {
      return JSON.parse(await readFile(marker, "utf8"));
    } catch {}
  });
  notice.action("revoke");
  const { error } = await execution;
  assert.equal(error.code, 125);
  assert.equal(JSON.parse(error.stdout).state, "revoked");
  assert.ok(!error.stdout.includes(DEMO_PASSWORD));
  await until(() => {
    try {
      process.kill(details.pid, 0);
    } catch (e) {
      return e.code === "ESRCH";
    }
  });
  await assert.rejects(stat(details.path), { code: "ENOENT" });
  assert.equal(broker.grants.get(id), undefined);
  assert.equal(broker.notices()[0].revoked, true);
  const next = await pending(broker, input);
  await broker.release(next.request_id);
});

test("revocation during provider fetch cancels delivery", async (t) => {
  const { broker, input, notifier } = await setup(t);
  await allow(broker, input);
  let resolve;
  broker.provider.get = () =>
    new Promise((r) => {
      resolve = r;
    });
  const request = broker.request(input);
  await until(() => !!resolve);
  notifier.shown[0].action("revoke");
  await until(async () => (await broker.status(request.request_id)).state === "revoked");
  resolve(JSON.stringify({ username: "fake", password: DEMO_PASSWORD }));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(await readdir(broker.leaseDir), []);
});
