import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { executeManualCredential } from "../src/manual.js";

async function setup(t, handler) {
  const runtime = await mkdtemp("/tmp/t3-browser-credential-test-");
  const host = join(runtime, "host.mjs");
  await writeFile(
    host,
    `import {runCredentialWorker} from ${JSON.stringify(new URL("../src/worker.js", import.meta.url).href)}; await runCredentialWorker(process.argv[3]);`,
  );
  const workerEntrypoint = [host, "__credential-broker-worker"];
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/private`;
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup) await close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(runtime, { recursive: true, force: true });
  });
  const origin = {
    environmentId: "test-env",
    threadId: "test-thread",
    threadTitle: "Test thread",
    providerInstanceId: "codex",
    providerSessionId: "session",
    runId: "run",
    toolCallId: "call",
    workspace: runtime,
    agent: "test",
  };
  const login = { username: "fake-manual-username", password: "fake-manual-password" };
  const options = {
    runtime,
    workerEntrypoint,
    origin,
    login,
    consumerEnvironment: { CB_BROWSER_ENDPOINT: endpoint },
    input: {
      site: "example.com",
      field: "login",
      label: "Browser sign-in",
      reason: "Test",
      ttlSeconds: 5,
      cwd: runtime,
      argv: [process.execPath, ...workerEntrypoint, "browser"],
    },
  };
  return { runtime, options, addCleanup: (close) => cleanup.push(close) };
}

test("private manual entry reaches only the supervised browser consumer and cleans up", async (t) => {
  let delivered;
  const { runtime, options } = await setup(t, async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    delivered = JSON.parse(body);
    response.end("ok");
  });
  const result = await executeManualCredential(options);
  assert.equal(result.state, "completed");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(delivered, options.login);
  assert.ok(!JSON.stringify(result).includes(options.login.password));
  assert.deepEqual(await readdir(join(runtime, "manual")), []);
});

test("stopping a manual sign-in interrupts its supervised caller and deletes the lease", async (t) => {
  let arrived;
  const receiving = new Promise((resolve) => {
    arrived = resolve;
  });
  const { runtime, options } = await setup(t, async (request) => {
    for await (const _ of request) {
      /* Deliberately withhold a response. */
    }
    arrived();
  });
  const controller = new AbortController();
  const pending = executeManualCredential({ ...options, signal: controller.signal });
  await receiving;
  controller.abort();
  const result = await pending;
  assert.equal(result.state, "released");
  assert.deepEqual(await readdir(join(runtime, "manual")), []);
});

test("expiry stops a stalled manual browser consumer and deletes active files", async (t) => {
  const { runtime, options } = await setup(t, async (request) => {
    for await (const _ of request) {
      /* Deliberately withhold a response. */
    }
  });
  const result = await executeManualCredential(options);
  assert.equal(result.state, "expired");
  assert.deepEqual(await readdir(join(runtime, "manual")), []);
});

import { T3CredentialBroker } from "../src/t3.js";
import { DemoProvider, DEMO_ITEM, DEMO_PASSWORD } from "../src/providers.js";

let viewSequence = 0;
function milestone(broker, predicate) {
  return new Promise((resolve) => {
    let unsubscribe;
    let done = false;
    unsubscribe = broker.subscribe("observer", String(++viewSequence), (state) => {
      if (done || !predicate(state)) return;
      done = true;
      queueMicrotask(() => unsubscribe());
      resolve(state);
    });
  });
}

for (const outcome of ["empty", "failed"]) {
  test(`browser manual entry remains available when vault search is ${outcome}`, async (t) => {
    let delivered = 0;
    let vaultReads = 0;
    const { runtime, options, addCleanup } = await setup(t, async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      assert.deepEqual(JSON.parse(body), options.login);
      delivered++;
      response.end("ok");
    });
    const provider = new DemoProvider();
    provider.search = async () => {
      if (outcome === "failed") throw new Error("private-provider-error");
      return [];
    };
    provider.get = async () => {
      vaultReads++;
      throw new Error("No saved login should be read.");
    };
    const broker = new T3CredentialBroker({
      runtime: join(runtime, "saved"),
      workerEntrypoint: options.workerEntrypoint,
      provider,
      watchdog: false,
    });
    addCleanup(() => broker.close());
    await broker.unlock();
    const pending = milestone(broker, (s) => s.requests.some((r) => r.state === "pending"));
    const execution = broker.execute(
      options.origin,
      options.input,
      undefined,
      options.consumerEnvironment,
    );
    const request = (await pending).requests.find((r) => r.state === "pending");
    assert.deepEqual(request.candidates, []);
    assert.equal(vaultReads, 0);
    assert.equal(delivered, 0);
    assert.ok(!JSON.stringify(broker.state()).includes("private-provider-error"));
    const result = await executeManualCredential(options);
    assert.equal(result.state, "completed");
    assert.equal(result.exitCode, 0);
    await broker.cancelCall(options.origin.toolCallId);
    assert.equal((await execution).state, "released");
    assert.equal(delivered, 1);
    assert.equal(vaultReads, 0);
    assert.equal(broker.state().grants.length, 0);
    assert.deepEqual(await readdir(join(runtime, "manual")), []);
    assert.deepEqual(await readdir(join(runtime, "saved", "leases")), []);
  });
}

test(
  "saved browser delivery denies without reading, then allows, automatically uses, dismisses, and revokes",
  { timeout: 15000 },
  async (t) => {
    let delivered = 0;
    let stall = false;
    let arrived;
    let disconnected;
    const disconnectedPromise = new Promise((resolve) => {
      disconnected = resolve;
    });
    const { runtime, options, addCleanup } = await setup(t, async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      assert.equal(JSON.parse(body).password, DEMO_PASSWORD);
      delivered++;
      if (stall) {
        response.once("close", disconnected);
        arrived();
      } else response.end("ok");
    });
    const broker = new T3CredentialBroker({
      runtime: join(runtime, "saved"),
      workerEntrypoint: options.workerEntrypoint,
      provider: new DemoProvider(),
      watchdog: false,
    });
    addCleanup(() => broker.close());
    await broker.unlock();
    const input = { ...options.input, ttlSeconds: 60 };
    const origin = options.origin;
    const start = async () => {
      const pending = milestone(broker, (s) => s.requests.some((r) => r.state === "pending"));
      const execution = broker.execute(origin, input, undefined, options.consumerEnvironment);
      return { execution, request: (await pending).requests.find((r) => r.state === "pending") };
    };
    const denied = await start();
    assert.ok(
      !JSON.stringify(broker.state()).includes(options.consumerEnvironment.CB_BROWSER_ENDPOINT),
    );
    await broker.action("human", {
      type: "decide",
      requestId: denied.request.requestId,
      decision: "deny",
    });
    assert.equal((await denied.execution).state, "denied");
    assert.equal(delivered, 0);
    const first = await start();
    await broker.action("human", {
      type: "decide",
      requestId: first.request.requestId,
      decision: "always",
      candidateId: DEMO_ITEM,
    });
    assert.equal((await first.execution).exitCode, 0);
    assert.equal(delivered, 1);
    const detach = broker.subscribe("human", "view", () => {});
    t.after(detach);
    await broker.action("human", { type: "presenter", viewId: "view", visible: true });
    const automatic = async () => {
      const appearing = milestone(broker, (s) => s.notices.length > 0);
      const execution = broker.execute(
        { ...origin, toolCallId: "automatic" },
        input,
        undefined,
        options.consumerEnvironment,
      );
      const notice = (await appearing).notices[0];
      await broker.action("human", { type: "seen", viewId: "view", noticeId: notice.noticeId });
      return { execution, notice };
    };
    const auto = await automatic();
    assert.equal((await auto.execution).exitCode, 0);
    await broker.action("human", { type: "dismiss", noticeId: auto.notice.noticeId });
    assert.equal(broker.state().grants.length, 1);
    stall = true;
    const receiving = new Promise((resolve) => {
      arrived = resolve;
    });
    const stopped = await automatic();
    await receiving;
    await broker.action("human", { type: "revoke", grantId: stopped.notice.grantId });
    assert.equal((await stopped.execution).state, "revoked");
    await disconnectedPromise;
    assert.equal(broker.state().grants.length, 0);
    assert.deepEqual(await readdir(join(runtime, "saved", "leases")), []);
    assert.ok(!JSON.stringify(broker.state()).includes(DEMO_PASSWORD));
  },
);
