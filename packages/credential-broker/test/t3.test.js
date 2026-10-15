import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
import { Broker } from "../src/broker.js";
import { T3CredentialBroker } from "../src/t3.js";
import { DemoProvider, DEMO_PASSWORD, DEMO_ITEM } from "../src/providers.js";
import { parseRequest } from "../src/common.js";

let sequence = 0;
const origin = {
  environmentId: "environment:test",
  threadId: "thread:actual",
  threadTitle: "Actual thread",
  providerInstanceId: "codex",
  providerSessionId: "session:actual",
  runId: "run:actual",
  toolCallId: "call:actual",
  workspace: "/tmp",
  agent: "test-model",
};
function milestone(broker, predicate) {
  return new Promise((resolve) => {
    let unsubscribe;
    let matched = false;
    unsubscribe = broker.subscribe("test-observer", String(++sequence), (state) => {
      if (matched || !predicate(state)) return;
      matched = true;
      queueMicrotask(() => unsubscribe());
      resolve(state);
    });
  });
}
async function setup(t, options = {}) {
  const runtime = await mkdtemp("/tmp/t3-credential-test-");
  const script = join(runtime, "consumer.mjs");
  const marker = join(runtime, "marker.json");
  await writeFile(
    script,
    'import fs from "node:fs"; const value=fs.readFileSync(process.env.CB_CREDENTIAL_FILE); process.stdout.write(value); process.stderr.write(value.toString("base64")); fs.writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,path:process.env.CB_CREDENTIAL_FILE,received:value.length>0,ambient:!!process.env.BW_SESSION,electronControl:!!process.env.ELECTRON_RUN_AS_NODE})); if(process.argv[3]==="wait") setInterval(()=>{},1000);',
  );
  let workerEntrypoint;
  if (options.hostWorker) {
    const host = join(runtime, "host.mjs");
    await writeFile(
      host,
      "import {runCredentialWorker} from " +
        JSON.stringify(new URL("../src/worker.js", import.meta.url).href) +
        "; await runCredentialWorker(process.argv[3]);",
    );
    workerEntrypoint = [host, "__credential-broker-worker"];
  }
  const broker = new T3CredentialBroker({
    runtime,
    workerEntrypoint,
    provider: new DemoProvider(),
    watchdog: false,
    ...options,
  });
  await broker.unlock();
  const caller = { ...origin, workspace: runtime };
  const input = {
    site: "example.com",
    field: "login",
    label: "Claimed label",
    reason: "Sign in",
    ttlSeconds: 60,
    argv: [process.execPath, script, marker],
    cwd: runtime,
  };
  t.after(async () => {
    await broker.close();
    await rm(runtime, { recursive: true, force: true });
  });
  return { broker, caller, input, runtime, marker, script };
}
async function pending(broker, caller, input) {
  const ready = milestone(broker, (s) => s.requests.some((r) => r.state === "pending"));
  const execution = broker.execute(caller, input);
  const state = await ready;
  return { execution, request: state.requests.find((r) => r.state === "pending") };
}
async function allow(broker, caller, input, decision = "once") {
  const { execution, request } = await pending(broker, caller, input);
  await broker.action("human", {
    type: "decide",
    requestId: request.requestId,
    decision,
    candidateId: DEMO_ITEM,
  });
  return { result: await execution, request };
}
function visible(broker, viewId = "view") {
  const detach = broker.subscribe("human", viewId, () => {});
  return broker.action("human", { type: "presenter", viewId, visible: true }).then(() => detach);
}
test("locked vault reports a safe actionable code before requesting access", async () => {
  const broker = new T3CredentialBroker({ runtime: "/unused" });
  await assert.rejects(broker.execute(origin, { site: "heihei" }), { code: "vault_locked" });
});
test("a local hostname can be privately approved and delivered to its consumer", async (t) => {
  const provider = new DemoProvider();
  provider.search = async (site) => {
    assert.equal(site, "heihei");
    return [{ item_id: DEMO_ITEM, name: "Local host", hosts: [site] }];
  };
  const { broker, caller, input, marker } = await setup(t, { provider });
  const { result } = await allow(broker, caller, { ...input, site: "heihei" });
  assert.equal(result.state, "completed");
  assert.equal(result.exitCode, 0);
  const delivery = JSON.parse(await readFile(marker, "utf8"));
  assert.equal(delivery.received, true);
  await assert.rejects(stat(delivery.path), { code: "ENOENT" });
  assert.ok(!JSON.stringify(result).includes(DEMO_PASSWORD));
});
async function auto(broker, caller, input) {
  const appearing = milestone(broker, (s) => s.notices.some((n) => !n.revoked));
  const execution = broker.execute(
    { ...caller, toolCallId: "call:next", providerSessionId: "session:next", runId: "run:next" },
    input,
  );
  const state = await appearing;
  const notice = state.notices.find((n) => !n.revoked);
  await broker.action("human", { type: "seen", viewId: "view", noticeId: notice.noticeId });
  return { execution, notice };
}
function markerReady(path) {
  return new Promise((resolve, reject) => {
    const observer = watch(join(path, ".."), async (_event, filename) => {
      if (filename !== "marker.json") return;
      try {
        const data = JSON.parse(await readFile(path, "utf8"));
        observer.close();
        resolve(data);
      } catch {}
    });
    observer.once("error", reject);
  });
}

test(
  "trusted identity is separate from labels; human selection gates actual execution and secret-free metadata",
  { timeout: 10000 },
  async (t) => {
    const { broker, caller, input, runtime, marker } = await setup(t);
    const { execution, request } = await pending(broker, caller, input);
    assert.deepEqual(request.origin, caller);
    assert.equal(request.label, "Claimed label");
    assert.equal(request.candidates[0].id, DEMO_ITEM);
    assert.deepEqual(await readdir(join(runtime, "leases")), []);
    await broker.action("human", {
      type: "decide",
      requestId: request.requestId,
      decision: "once",
      candidateId: DEMO_ITEM,
    });
    const result = await execution;
    assert.equal(result.state, "completed");
    assert.equal(result.exitCode, 0);
    assert.deepEqual(Object.keys(result).sort(), ["exitCode", "expiresAt", "requestId", "state"]);
    assert.ok(!JSON.stringify(result).includes(DEMO_PASSWORD));
    assert.ok(!JSON.stringify(broker.state()).includes(DEMO_PASSWORD));
    assert.ok(!JSON.stringify(broker.state()).includes("demo@example.com"));
    const data = JSON.parse(await readFile(marker, "utf8"));
    assert.equal(data.received, true);
    assert.equal(data.ambient, false);
    await assert.rejects(stat(data.path), { code: "ENOENT" });
  },
);

test("denial and approval expiry never deliver credentials; late decisions fail", async (t) => {
  let now = Date.now();
  const { broker, caller, input, runtime } = await setup(t, { now: () => now });
  const denied = await pending(broker, caller, input);
  await broker.action("human", {
    type: "decide",
    requestId: denied.request.requestId,
    decision: "deny",
  });
  assert.equal((await denied.execution).state, "denied");
  const expired = await pending(broker, caller, input);
  now += 120001;
  await broker.sweep();
  assert.equal((await expired.execution).state, "expired");
  await assert.rejects(
    broker.action("human", {
      type: "decide",
      requestId: expired.request.requestId,
      decision: "once",
      candidateId: DEMO_ITEM,
    }),
  );
  assert.deepEqual(await readdir(join(runtime, "leases")), []);
});

test(
  "automatic access waits for remote visibility, lasts five full minutes after acknowledgment and command exit; dismiss retains grant",
  { timeout: 10000 },
  async (t) => {
    let now = Date.now();
    const { broker, caller, input } = await setup(t, { now: () => now });
    const detach = await visible(broker);
    t.after(detach);
    await allow(broker, caller, input, "always");
    const appearing = milestone(broker, (s) => s.notices.length > 0);
    const execution = broker.execute(
      { ...caller, toolCallId: "call:second" },
      { ...input, label: "Different claim" },
    );
    const state = await appearing;
    assert.equal(state.requests[0].state, "pending");
    const notice = state.notices[0];
    await assert.rejects(
      broker.action("other-human-session", {
        type: "seen",
        viewId: "view",
        noticeId: notice.noticeId,
      }),
    );
    now += 4000;
    await broker.action("human", { type: "seen", viewId: "view", noticeId: notice.noticeId });
    assert.equal((await execution).state, "completed");
    assert.equal(broker.state().notices[0].expiresAt, now + 300000);
    now += 299999;
    await broker.sweep();
    assert.equal(broker.state().notices.length, 1);
    now++;
    await broker.sweep();
    assert.equal(broker.state().notices.length, 0);
    const next = await auto(broker, caller, input);
    await next.execution;
    await broker.action("human", { type: "dismiss", noticeId: next.notice.noticeId });
    assert.equal(broker.state().notices.length, 0);
    assert.equal(broker.state().grants.length, 1);
  },
);

test(
  "revoke & stop deletes files, stops actual supervised caller, ends the corresponding tool call and prevents another automatic use",
  { timeout: 10000 },
  async (t) => {
    const { broker, caller, input, marker, runtime } = await setup(t);
    const detach = await visible(broker);
    t.after(detach);
    const waitingInput = { ...input, argv: [...input.argv, "wait"] };
    const first = await pending(broker, caller, waitingInput);
    await broker.action("human", {
      type: "decide",
      requestId: first.request.requestId,
      decision: "always",
      candidateId: DEMO_ITEM,
    });
    await broker.action("human", { type: "stop", requestId: first.request.requestId });
    await first.execution;
    await rm(marker, { force: true });
    const started = markerReady(marker);
    const automatic = await auto(broker, caller, waitingInput);
    const data = await started;
    await broker.action("human", { type: "revoke", grantId: automatic.notice.grantId });
    assert.equal((await automatic.execution).state, "revoked");
    assert.throws(() => process.kill(data.pid, 0), { code: "ESRCH" });
    await assert.rejects(stat(data.path), { code: "ENOENT" });
    assert.deepEqual(await readdir(join(runtime, "leases")), []);
    assert.equal(broker.state().grants.length, 0);
    const next = await pending(broker, caller, waitingInput);
    await broker.action("human", {
      type: "decide",
      requestId: next.request.requestId,
      decision: "deny",
    });
    await next.execution;
  },
);

test(
  "no visible presenter requires manual approval; disconnected presenter stops automatic caller",
  { timeout: 10000 },
  async (t) => {
    const { broker, caller, input } = await setup(t);
    const first = await allow(broker, caller, input, "always");
    const manual = await pending(broker, caller, input);
    assert.equal(broker.state().notices.length, 0);
    await broker.action("human", {
      type: "decide",
      requestId: manual.request.requestId,
      decision: "deny",
    });
    await manual.execution;
    const detach = await visible(broker);
    const automatic = await auto(broker, caller, input);
    detach();
    assert.equal((await automatic.execution).state, "revoked");
    assert.equal(broker.state().grants.length, 1);
    assert.equal(first.result.state, "completed");
  },
);

test(
  "tool cancellation, session cancellation and active expiry clean up without output",
  { timeout: 10000 },
  async (t) => {
    let now = Date.now();
    const { broker, caller, input, marker } = await setup(t, { now: () => now });
    const ready = milestone(broker, (s) => s.requests.some((r) => r.state === "pending"));
    const controller = new AbortController();
    const execution = broker.execute(caller, input, controller.signal);
    await ready;
    controller.abort();
    assert.equal((await execution).state, "released");
    const waiting = { ...input, argv: [...input.argv, "wait"] };
    const started = markerReady(marker);
    const active = await pending(broker, caller, waiting);
    await broker.action("human", {
      type: "decide",
      requestId: active.request.requestId,
      decision: "once",
      candidateId: DEMO_ITEM,
    });
    const data = await started;
    await broker.cancelSession(caller.providerSessionId);
    assert.equal((await active.execution).state, "released");
    assert.throws(() => process.kill(data.pid, 0), { code: "ESRCH" });
    await rm(marker, { force: true });
    const expiryStarted = markerReady(marker);
    const lease = await pending(broker, caller, waiting);
    await broker.action("human", {
      type: "decide",
      requestId: lease.request.requestId,
      decision: "once",
      candidateId: DEMO_ITEM,
    });
    const second = await expiryStarted;
    now += 60000;
    await broker.sweep();
    assert.equal((await lease.execution).state, "expired");
    assert.throws(() => process.kill(second.pid, 0), { code: "ESRCH" });
    await assert.rejects(stat(second.path), { code: "ENOENT" });
  },
);

test(
  "changed identity and script bytes require fresh approval; CLI cannot supply trusted origin",
  { timeout: 10000 },
  async (t) => {
    const { broker, caller, input, script } = await setup(t);
    const detach = await visible(broker);
    t.after(detach);
    await allow(broker, caller, input, "always");
    for (const changed of [
      { threadId: "thread:other" },
      { environmentId: "environment:other" },
      { providerInstanceId: "claude" },
      { workspace: "/" },
    ]) {
      const request = await pending(broker, { ...caller, ...changed }, input);
      assert.equal(broker.state().notices.length, 0);
      await broker.action("human", {
        type: "decide",
        requestId: request.request.requestId,
        decision: "deny",
      });
      await request.execution;
    }
    await writeFile(script, "process.exit(0);");
    const changed = await pending(broker, caller, input);
    await broker.action("human", {
      type: "decide",
      requestId: changed.request.requestId,
      decision: "deny",
    });
    await changed.execution;
    assert.throws(
      () =>
        parseRequest({
          kind: "exec",
          site: "example.com",
          label: "Claim",
          reason: "Claim",
          argv: input.argv,
          cwd: input.cwd,
          file_env: "CB_CREDENTIAL_FILE",
          origin: caller,
        }),
      /Invalid request/,
    );
  },
);

test("Windows fails closed without vault access", async () => {
  let initialized = false;
  const broker = new T3CredentialBroker({
    runtime: "/unused",
    platform: "win32",
    provider: {
      initialize() {
        initialized = true;
      },
    },
  });
  assert.equal(broker.state().status, "unsupported");
  await assert.rejects(broker.unlock());
  assert.equal(initialized, false);
});

test("host worker entry preserves IPC and does not pass Electron control to consumers", async (t) => {
  const { broker, caller, input, marker } = await setup(t, { hostWorker: true, watchdog: true });
  input.ttlSeconds = 5;
  const { result } = await allow(broker, caller, input);
  assert.equal(result.state, "completed");
  assert.equal(result.exitCode, 0);
  const consumer = JSON.parse(await readFile(marker, "utf8"));
  assert.equal(consumer.received, true);
  assert.equal(consumer.ambient, false);
  assert.equal(consumer.electronControl, false);
  await assert.rejects(stat(consumer.path), { code: "ENOENT" });
});

test("a failed host worker does not settle the tool before credential cleanup", async (t) => {
  const { broker, caller, input, runtime } = await setup(t, {
    workerEntrypoint: ["/missing-worker.mjs"],
  });
  const original = Broker.prototype.remove;
  let releaseCleanup, reached;
  const gate = new Promise((resolve) => {
    releaseCleanup = resolve;
  });
  const cleaning = new Promise((resolve) => {
    reached = resolve;
  });
  Broker.prototype.remove = async function (request) {
    reached();
    await gate;
    return original.call(this, request);
  };
  t.after(() => {
    Broker.prototype.remove = original;
  });
  const { execution, request } = await pending(broker, caller, input);
  let settled = false;
  execution.then(() => {
    settled = true;
  });
  const approval = broker.action("human", {
    type: "decide",
    requestId: request.requestId,
    decision: "once",
    candidateId: DEMO_ITEM,
  });
  await cleaning;
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(settled, false);
  } finally {
    releaseCleanup();
  }
  await approval;
  assert.equal((await execution).state, "failed");
  assert.deepEqual(await readdir(join(runtime, "leases")), []);
});
