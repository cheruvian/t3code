import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  rm,
  stat,
  chmod,
  unlink,
  mkdir,
  symlink,
  realpath,
} from "node:fs/promises";
import { watch } from "node:fs";
import { join, relative } from "node:path";
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
test("host lookup pins the executable shown for approval even if its PATH symlink changes", async (t) => {
  const { caller, input, runtime, marker } = await setup(t, { searchPath: "" });
  const bin = join(runtime, "bin");
  await mkdir(bin);
  const alias = join(bin, "uv");
  await symlink(process.execPath, alias);
  // This is host configuration, never request input or a caller-supplied PATH.
  const hostRuntime = await mkdtemp("/tmp/t3-command-host-");
  const host = new T3CredentialBroker({
    runtime: hostRuntime,
    provider: new DemoProvider(),
    watchdog: false,
    searchPath: bin,
  });
  t.after(async () => {
    await host.close();
    await rm(hostRuntime, { recursive: true, force: true });
  });
  await host.unlock();
  const named = { ...input, argv: ["uv", ...input.argv.slice(1)] };
  const { execution, request } = await pending(host, caller, named);
  assert.equal(request.argv[0], await realpath(process.execPath));
  assert.equal(named.argv[0], "uv");
  const replacement = join(runtime, "replacement");
  await writeFile(replacement, "#!/bin/sh\nexit 73\n", { mode: 0o700 });
  await unlink(alias);
  await symlink(replacement, alias);
  await host.action("human", {
    type: "decide",
    requestId: request.requestId,
    decision: "always",
    candidateId: DEMO_ITEM,
  });
  const result = await execution;
  assert.equal(result.state, "completed");
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(await readFile(marker, "utf8")).received, true);
  assert.equal(host.state().grants[0].argv[0], request.argv[0]);
  await visible(host);
  const changed = await pending(host, caller, named);
  assert.equal(changed.request.argv[0], await realpath(replacement));
  assert.equal(host.state().notices.length, 0);
  await host.action("human", {
    type: "decide",
    requestId: changed.request.requestId,
    decision: "deny",
  });
  assert.equal((await changed.execution).state, "denied");
  await assert.rejects(stat(JSON.parse(await readFile(marker, "utf8")).path), { code: "ENOENT" });
});

test("host lookup skips nonexecutable PATH entries and refuses missing names and relative paths before vault search", async (t) => {
  const provider = new DemoProvider();
  let searches = 0;
  provider.search = async () => {
    searches++;
    return [];
  };
  const { broker, caller, input, runtime } = await setup(t, {
    provider,
    searchPath: "relative::/missing-path",
  });
  await writeFile(join(runtime, "missing-uv"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  broker.searchPath = `${relative(process.cwd(), runtime)}::/missing-path`;
  for (const program of ["missing-uv", "./uv", "bin/uv", "bin\\uv"]) {
    await assert.rejects(broker.execute(caller, { ...input, argv: [program] }), {
      code:
        program.includes("/") || program.includes("\\")
          ? "invalid_request"
          : "consumer_unavailable",
    });
  }
  assert.equal(searches, 0);
  assert.deepEqual(broker.state().requests, []);
  const bin = join(runtime, "bin");
  const fallback = join(runtime, "fallback");
  await mkdir(bin);
  await mkdir(fallback);
  await writeFile(join(bin, "uv"), "not executable", { mode: 0o600 });
  await symlink(process.execPath, join(fallback, "uv"));
  const hostRuntime = await mkdtemp("/tmp/t3-command-host-");
  const host = new T3CredentialBroker({
    runtime: hostRuntime,
    provider: new DemoProvider(),
    watchdog: false,
    searchPath: `${bin}:${fallback}`,
  });
  t.after(async () => {
    await host.close();
    await rm(hostRuntime, { recursive: true, force: true });
  });
  await host.unlock();
  const next = await pending(host, caller, { ...input, argv: ["uv", ...input.argv.slice(1)] });
  assert.equal(next.request.argv[0], await realpath(process.execPath));
  await host.action("human", {
    type: "decide",
    requestId: next.request.requestId,
    decision: "deny",
  });
  assert.equal((await next.execution).state, "denied");
});

test("missing consumer executable fails before vault search, approval, or credential delivery", async (t) => {
  const provider = new DemoProvider();
  let searches = 0;
  provider.search = async () => {
    searches++;
    throw new Error("fake-secret");
  };
  const { broker, caller, input, runtime } = await setup(t, { provider });
  for (const change of [
    { argv: [join(runtime, "missing-uv"), "run", "python", "import.py"] },
    { cwd: join(runtime, "missing-workspace") },
  ]) {
    await assert.rejects(broker.execute(caller, { ...input, ...change }), {
      code: "consumer_unavailable",
    });
  }
  const notExecutable = join(runtime, "not-executable");
  await writeFile(notExecutable, "fake-secret", { mode: 0o600 });
  await chmod(notExecutable, 0o600);
  await assert.rejects(broker.execute(caller, { ...input, argv: [notExecutable] }), {
    code: "consumer_unavailable",
  });
  assert.equal(searches, 0);
  assert.deepEqual(broker.state().requests, []);
  assert.deepEqual(await readdir(join(runtime, "leases")), []);
});
test("consumer disappearing after approval selection returns a safe startup failure reason", async (t) => {
  const { broker, caller, input, runtime } = await setup(t);
  const executable = join(runtime, "vanishing-consumer");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const { execution, request } = await pending(broker, caller, { ...input, argv: [executable] });
  await unlink(executable);
  await broker.action("human", {
    type: "decide",
    requestId: request.requestId,
    decision: "once",
    candidateId: DEMO_ITEM,
  });
  const result = await execution;
  assert.equal(result.state, "failed");
  assert.equal(result.failureCode, "consumer_start_failed");
  assert.ok(!JSON.stringify(result).includes(DEMO_PASSWORD));
  assert.deepEqual(await readdir(join(runtime, "leases")), []);
});
test("T3 approval stays pending across a day and credential lifetime starts only after approval", async (t) => {
  let now = Date.now();
  let reads = 0;
  const provider = new DemoProvider();
  const get = provider.get.bind(provider);
  provider.get = async (...args) => {
    reads++;
    return get(...args);
  };
  const { broker, caller, input, marker, runtime } = await setup(t, { provider, now: () => now });
  const { execution, request } = await pending(broker, caller, input);
  assert.equal(request.approvalDeadline, null);
  now += 24 * 60 * 60 * 1000;
  await broker.sweep();
  assert.equal(broker.state().requests[0].state, "pending");
  assert.equal(reads, 0);
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
  assert.equal(result.expiresAt, now + input.ttlSeconds * 1000);
  assert.equal(reads, 1);
  const delivery = JSON.parse(await readFile(marker, "utf8"));
  await assert.rejects(stat(delivery.path), { code: "ENOENT" });
});
test("locked requests publish trusted identity, survive failed unlock, and still require approval", async (t) => {
  const provider = new DemoProvider();
  let searches = 0;
  const search = provider.search.bind(provider);
  provider.search = async (site) => {
    searches++;
    return search(site);
  };
  const { broker, caller, input, marker } = await setup(t, { provider });
  await broker.lock();
  const waiting = milestone(broker, (s) => s.requests.some((r) => r.state === "awaiting_unlock"));
  const execution = broker.execute(caller, input);
  const state = await waiting;
  const queued = state.requests[0];
  assert.deepEqual(queued.origin, caller);
  assert.equal(state.status, "locked");
  assert.deepEqual(queued.candidates, []);
  assert.equal(searches, 0);
  await assert.rejects(
    broker.action("human", { type: "decide", requestId: queued.requestId, decision: "once" }),
  );
  provider.initialize = async () => {
    throw new Error("fake unlock failure");
  };
  await assert.rejects(broker.unlock());
  assert.equal(broker.state().requests[0].state, "awaiting_unlock");
  provider.initialize = async () => {};
  const ready = milestone(broker, (s) => s.requests.some((r) => r.state === "pending"));
  await broker.unlock();
  const request = (await ready).requests.find((r) => r.state === "pending");
  await assert.rejects(stat(marker), { code: "ENOENT" });
  await broker.action("human", {
    type: "decide",
    requestId: request.requestId,
    decision: "once",
    candidateId: DEMO_ITEM,
  });
  assert.equal((await execution).exitCode, 0);
  assert.equal(JSON.parse(await readFile(marker, "utf8")).received, true);
});
test("requests arriving during unlock wait and then require a separate decision", async (t) => {
  const { broker, caller, input } = await setup(t);
  await broker.lock();
  let finishUnlock;
  let started;
  const unlockStarted = new Promise((resolve) => {
    started = resolve;
  });
  broker.provider.initialize = () =>
    new Promise((resolve) => {
      finishUnlock = resolve;
      started();
    });
  const unlocking = broker.unlock();
  await unlockStarted;
  const waiting = milestone(broker, (s) => s.requests.some((r) => r.state === "awaiting_unlock"));
  const execution = broker.execute(caller, input);
  assert.equal((await waiting).status, "unlocking");
  const ready = milestone(broker, (s) => s.requests.some((r) => r.state === "pending"));
  finishUnlock();
  await unlocking;
  const request = (await ready).requests.find((r) => r.state === "pending");
  await broker.action("human", { type: "decide", requestId: request.requestId, decision: "deny" });
  assert.equal((await execution).state, "denied");
});
test("closing during unlock releases waiting callers and closes the eventual provider", async (t) => {
  const { broker, caller, input } = await setup(t);
  await broker.lock();
  let started, finishUnlock;
  const unlockStarted = new Promise((resolve) => {
    started = resolve;
  });
  broker.provider.initialize = () =>
    new Promise((resolve) => {
      finishUnlock = resolve;
      started();
    });
  const unlocking = broker.unlock();
  await unlockStarted;
  const waiting = milestone(broker, (s) => s.requests.some((r) => r.state === "awaiting_unlock"));
  const execution = broker.execute(caller, input);
  await waiting;
  await broker.close();
  assert.equal((await execution).state, "released");
  finishUnlock();
  await unlocking;
  assert.equal(broker.state().status, "locked");
  assert.deepEqual(broker.state().requests, []);
});
test("caller cancellation at unlock completion cannot start a vault search", async (t) => {
  const { broker, caller, input } = await setup(t);
  await broker.lock();
  let searches = 0;
  broker.provider.search = async () => {
    searches++;
    return [];
  };
  const controller = new AbortController();
  const waiting = milestone(broker, (s) => s.requests.some((r) => r.state === "awaiting_unlock"));
  const execution = broker.execute(caller, input, controller.signal);
  const rejected = assert.rejects(execution, { code: "caller_cancelled" });
  await waiting;
  const detach = broker.subscribe("cancel-on-ready", "view", (s) => {
    if (s.status === "ready") controller.abort();
  });
  await broker.unlock();
  await rejected;
  detach();
  assert.equal(searches, 0);
  assert.deepEqual(broker.state().requests, []);
});
for (const cancellation of ["deny", "stop", "abort", "call", "session", "lock", "close"]) {
  test(`waiting for unlock is cancelled by ${cancellation} without vault access`, async (t) => {
    const { broker, caller, input } = await setup(t);
    await broker.lock();
    const controller = new AbortController();
    const waiting = milestone(broker, (s) => s.requests.some((r) => r.state === "awaiting_unlock"));
    const execution = broker.execute(caller, input, controller.signal);
    const requestId = (await waiting).requests[0].requestId;
    if (cancellation === "deny")
      await broker.action("human", { type: "decide", requestId, decision: "deny" });
    if (cancellation === "stop") await broker.action("human", { type: "stop", requestId });
    if (cancellation === "abort") controller.abort();
    if (cancellation === "call") await broker.cancelCall(caller.toolCallId);
    if (cancellation === "session") await broker.cancelSession(caller.providerSessionId);
    if (cancellation === "lock") await broker.lock();
    if (cancellation === "close") await broker.close();
    assert.equal((await execution).state, cancellation === "deny" ? "denied" : "released");
    assert.deepEqual(broker.state().requests, []);
  });
}
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

test("denial and an explicitly configured approval deadline never deliver credentials", async (t) => {
  let now = Date.now();
  const { broker, caller, input, runtime } = await setup(t, {
    now: () => now,
    approvalTimeout: 120000,
  });
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
  const result = await execution;
  assert.equal(result.state, "failed");
  assert.equal(result.failureCode, "supervisor_start_failed");
  assert.deepEqual(await readdir(join(runtime, "leases")), []);
});

for (const scenario of ["no_matching_login", "vault_search_failed"]) {
  test(`vault lookup reports ${scenario} without waiting for another UI action`, async (t) => {
    class SearchProvider extends DemoProvider {
      async search() {
        if (scenario === "vault_search_failed") throw new Error("private provider details");
        return [];
      }
    }
    const { broker, caller, input, runtime } = await setup(t, { provider: new SearchProvider() });
    const result = await broker.execute(caller, input);
    assert.equal(broker.state().status, "ready");
    assert.equal(result.state, "failed");
    assert.equal(result.failureCode, scenario);
    assert.equal(result.exitCode, undefined);
    assert.equal(JSON.stringify(result).includes("private provider details"), false);
    assert.deepEqual(await readdir(join(runtime, "leases")), []);
  });
}

class SavingProvider extends DemoProvider {
  saved;
  async search() {
    return [];
  }
  async create(site, login) {
    this.saved = { site, ...login };
    return { item_id: DEMO_ITEM, name: "New login", hosts: [site] };
  }
  async get(item, field, site) {
    assert.equal(item, DEMO_ITEM);
    assert.equal(site, this.saved.site);
    return field === "login"
      ? JSON.stringify({ username: this.saved.username, password: this.saved.password })
      : this.saved[field];
  }
}

for (const searchFails of [false, true]) {
  test(`private save and allow once handles ${searchFails ? "failed" : "empty"} lookup without exposing the login`, async (t) => {
    const provider = new SavingProvider();
    if (searchFails)
      provider.search = async () => {
        throw new Error("private-search-output");
      };
    const { broker, caller, input, marker } = await setup(t, { provider });
    const { execution, request } = await pending(broker, caller, input);
    assert.equal(request.canSave, true);
    assert.match(request.error, searchFails ? /lookup failed/ : /No matching login/);
    await broker.action("human", {
      type: "saveLogin",
      requestId: request.requestId,
      username: "private-user",
      password: "private-password",
    });
    const result = await execution;
    assert.equal(result.state, "completed");
    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(await readFile(marker, "utf8")).received, true);
    assert.deepEqual(provider.saved, {
      site: "example.com",
      username: "private-user",
      password: "private-password",
    });
    assert.equal(broker.state().grants.length, 0);
    const metadata = JSON.stringify({ state: broker.state(), result });
    for (const secret of ["private-user", "private-password", "private-search-output"])
      assert.equal(metadata.includes(secret), false);
    await assert.rejects(
      broker.action("human", {
        type: "saveLogin",
        requestId: request.requestId,
        username: "",
        password: "retry",
      }),
      /no longer/,
    );
  });
}

test("save failure leaves a private actionable error and a request that can be denied", async (t) => {
  const provider = new SavingProvider();
  provider.create = async () => {
    throw new Error("private-vault-error");
  };
  const { broker, caller, input, runtime } = await setup(t, { provider });
  const { execution, request } = await pending(broker, caller, input);
  await assert.rejects(
    broker.action("human", {
      type: "saveLogin",
      requestId: request.requestId,
      username: "user",
      password: "password",
    }),
    /Could not save/,
  );
  assert.equal(broker.state().requests[0].state, "pending");
  assert.match(broker.state().requests[0].error, /Check Bitwarden before retrying/);
  assert.equal(JSON.stringify(broker.state()).includes("private-vault-error"), false);
  assert.deepEqual(await readdir(join(runtime, "leases")), []);
  await broker.action("human", { type: "decide", requestId: request.requestId, decision: "deny" });
  assert.equal((await execution).state, "denied");
});

test("stop during a save prevents credential delivery and concurrent saves", async (t) => {
  const provider = new SavingProvider();
  let finishSave;
  const saving = new Promise((resolve) => {
    finishSave = resolve;
  });
  const create = provider.create.bind(provider);
  provider.create = async (...args) => {
    await saving;
    return create(...args);
  };
  const { broker, caller, input, runtime, marker } = await setup(t, { provider });
  const { execution, request } = await pending(broker, caller, input);
  const savingState = milestone(broker, (s) => s.requests.some((r) => r.state === "saving"));
  const action = {
    type: "saveLogin",
    requestId: request.requestId,
    username: "user",
    password: "password",
  };
  const save = broker.action("human", action);
  await savingState;
  await assert.rejects(broker.action("human", action), /no longer/);
  await broker.action("human", { type: "stop", requestId: request.requestId });
  assert.equal((await execution).state, "released");
  finishSave();
  await save;
  assert.deepEqual(await readdir(join(runtime, "leases")), []);
  await assert.rejects(stat(marker), { code: "ENOENT" });
});

test("password-only requests can save without a username but login requests require both fields", async (t) => {
  const provider = new SavingProvider();
  const { broker, caller, input } = await setup(t, { provider });
  const first = await pending(broker, caller, input);
  await assert.rejects(
    broker.action("human", {
      type: "saveLogin",
      requestId: first.request.requestId,
      username: "",
      password: "password",
    }),
    /requested login fields/,
  );
  await broker.action("human", {
    type: "decide",
    requestId: first.request.requestId,
    decision: "deny",
  });
  await first.execution;
  const second = await pending(broker, caller, { ...input, field: "password" });
  await broker.action("human", {
    type: "saveLogin",
    requestId: second.request.requestId,
    username: "",
    password: "password",
  });
  assert.equal((await second.execution).state, "completed");
});
