import test from "node:test";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Broker } from "../src/broker.js";
import { startServers } from "../src/server.js";
import { callBroker } from "../src/client.js";
import { DemoProvider, DEMO_ITEM, DEMO_PASSWORD } from "../src/providers.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const input = {
  item_id: DEMO_ITEM,
  label: "Demo GitHub",
  reason: "Smoke test",
  ttl_seconds: 5,
};
const execute = promisify(execFile);

async function setup(t) {
  const runtime = await mkdtemp("/tmp/cb-api-");
  const broker = new Broker({
    runtime,
    provider: new DemoProvider(),
    watchdog: false,
  });
  await broker.initialize();
  const server = await startServers(broker, {
    port: 0,
    host: "127.0.0.1",
    publicUrl: "http://test.invalid",
  });
  const url = `http://127.0.0.1:${server.port}`;
  t.after(async () => {
    await server.close();
    await broker.close();
    await rm(runtime, { recursive: true, force: true });
  });
  const admin = (path, method = "GET", headers = {}) =>
    fetch(`${url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${server.adminToken}`,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
  return { runtime, broker, server, url, admin };
}

test("agent cannot approve; dashboard requires operator token and rejects foreign origins", async (t) => {
  const { runtime, url, admin } = await setup(t);
  const pending = await callBroker("/requests", {
    runtime,
    method: "POST",
    data: input,
  });
  await assert.rejects(
    callBroker(`/requests/${pending.request_id}/approve`, {
      runtime,
      method: "POST",
      data: {},
    }),
    /only in the human/,
  );
  assert.equal((await fetch(`${url}/api/state`)).status, 401);
  assert.equal(
    (
      await fetch(`${url}/api/requests/${pending.request_id}/approve`, {
        method: "POST",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await admin(`/api/requests/${pending.request_id}/approve`, "POST", {
        Origin: "https://evil.example",
      })
    ).status,
    403,
  );
  assert.equal((await callBroker(`/requests/${pending.request_id}`, { runtime })).state, "pending");
  const approved = await (
    await admin(`/api/requests/${pending.request_id}/approve`, "POST")
  ).json();
  assert.equal(approved.state, "active");
  assert.ok(!JSON.stringify(approved).includes(DEMO_PASSWORD));
  assert.equal((await stat(`${runtime}/agent.sock`)).mode & 0o777, 0o600);
});

test("actual CLI request/status/release emits only metadata", async (t) => {
  const { runtime, admin } = await setup(t);
  const run = (...args) => execute(process.execPath, [cli, ...args, "--runtime", runtime]);
  const pendingText = (
    await run("request", "--item", DEMO_ITEM, "--label", "CLI demo", "--reason", "CLI smoke test")
  ).stdout;
  const pending = JSON.parse(pendingText);
  assert.equal(pending.state, "pending");
  await admin(`/api/requests/${pending.request_id}/approve`, "POST");
  const activeText = (await run("status", pending.request_id)).stdout;
  const active = JSON.parse(activeText);
  assert.equal(active.state, "active");
  assert.ok(!activeText.includes(DEMO_PASSWORD));
  const released = JSON.parse((await run("release", pending.request_id)).stdout);
  assert.equal(released.state, "released");
  await assert.rejects(stat(active.path), { code: "ENOENT" });
});

test("MCP entry point is unavailable and help describes CLI-only secret handling", async () => {
  await assert.rejects(execute(process.execPath, [cli, "mcp"]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /CLI-only/);
    assert.equal(error.stdout, "");
    return true;
  });
  const { stdout } = await execute(process.execPath, [cli, "--help"]);
  assert.match(stdout, /never printed/);
  assert.match(stdout, /stdout\/stderr are discarded/);
});

test(
  "detached expiry timer deletes a credential file after broker SIGKILL",
  { timeout: 15_000 },
  async (t) => {
    const runtime = await mkdtemp("/tmp/cb-crash-");
    let child;
    t.after(async () => {
      if (child?.exitCode === null && !child.killed) child.kill("SIGKILL");
      await rm(runtime, { recursive: true, force: true });
    });
    // A dedicated child avoids killing the test runner. Only fake values are used.
    const script = `import {Broker} from './src/broker.js'; import {DemoProvider,DEMO_ITEM} from './src/providers.js'; const b=new Broker({runtime:process.argv[1],provider:new DemoProvider()}); await b.initialize(); const r=await b.decide(b.request({item_id:DEMO_ITEM,label:'crash test',reason:'expiry',ttl_seconds:5}).request_id,true); console.log(JSON.stringify({path:r.path,expires_at:r.expires_at})); setInterval(()=>{},1000);`;
    child = spawn(process.execPath, ["--input-type=module", "-e", script, runtime], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = await new Promise((resolve, reject) => {
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("\n")) resolve(JSON.parse(output.trim()));
      });
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Crash fixture exited before producing a lease.")));
    });
    await stat(result.path);
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    const deadline = result.expires_at + 2_000;
    let deleted = false;
    while (Date.now() < deadline) {
      try {
        await stat(result.path);
      } catch (error) {
        if (error.code === "ENOENT") {
          deleted = true;
          break;
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(deleted, true, "file removed even though the broker process is dead");
    const recovered = new Broker({
      runtime,
      provider: new DemoProvider(),
      watchdog: false,
    });
    await recovered.initialize();
    await recovered.close();
  },
);

test("T3 CLI forwards command names for broker-side lookup instead of resolving the CLI host PATH", async (t) => {
  let requested;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    if (rpc.method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
      return;
    }
    let result = {};
    if (rpc.method === "tools/call") {
      requested = rpc.params.arguments;
      result = {
        structuredContent: { requestId: "fake-request", state: "completed", exitCode: 0 },
      };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const program = "t3-broker-test-only-remote-command";
  const { stdout } = await execute(
    process.execPath,
    [
      cli,
      "exec",
      "--t3",
      "--site",
      "example.com",
      "--reason",
      "Verify host lookup",
      "--",
      program,
      "--consumer-option",
    ],
    {
      env: {
        ...process.env,
        T3_ACP_MCP_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
        T3_ACP_MCP_AUTHORIZATION: "Bearer fake-request-only",
      },
    },
  );
  assert.deepEqual(requested.argv, [program, "--consumer-option"]);
  assert.equal(JSON.parse(stdout).state, "completed");
});
