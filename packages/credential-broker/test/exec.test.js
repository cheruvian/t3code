import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Broker } from "../src/broker.js";
import { startServers } from "../src/server.js";
import { DemoProvider, DEMO_ITEM, DEMO_PASSWORD } from "../src/providers.js";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const base = {
  kind: "exec",
  item_id: DEMO_ITEM,
  label: "Approved command",
  reason: "Test use-time approval",
  ttl_seconds: 5,
  file_env: "CB_CREDENTIAL_FILE",
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(30);
  }
  throw new Error("Expected execution state did not arrive.");
}
async function setup(t) {
  const runtime = await mkdtemp("/tmp/cb-exec-");
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
  t.after(async () => {
    await server.close();
    await broker.close();
    await rm(runtime, { recursive: true, force: true });
  });
  return { runtime, broker };
}

test("one CLI exec waits for approval, suppresses raw/encoded child output, cleans up, and strips ambient secrets", async (t) => {
  const { runtime, broker } = await setup(t);
  process.env.CB_AMBIENT_TEST_SECRET = "should-not-reach-child";
  t.after(() => {
    delete process.env.CB_AMBIENT_TEST_SECRET;
  });
  const marker = join(runtime, "command-result.json");
  const program =
    'const fs=require("node:fs");const secret=fs.readFileSync(process.env.CB_CREDENTIAL_FILE);process.stdout.write(secret);process.stderr.write(secret.toString("base64"));fs.writeFileSync(process.argv[1],JSON.stringify({length:secret.length,ambient:!!process.env.CB_AMBIENT_TEST_SECRET,session:!!process.env.BW_SESSION,args:process.argv.slice(2)}));';
  // Observe failure immediately rather than leaving a rejected child promise unhandled.
  const execution = execute(
    process.execPath,
    [
      cli,
      "exec",
      "--runtime",
      runtime,
      "--item",
      DEMO_ITEM,
      "--label",
      base.label,
      "--reason",
      base.reason,
      "--ttl",
      "5",
      "--",
      process.execPath,
      "-e",
      program,
      marker,
      "literal;argument",
      "$(literal)",
    ],
    { timeout: 10_000 },
  ).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const pending = await until(async () => (await broker.list()).find((r) => r.kind === "exec"));
  assert.equal(pending.state, "pending");
  assert.equal(
    pending.argv[0],
    await import("node:fs/promises").then((fs) => fs.realpath(process.execPath)),
  );
  assert.deepEqual(await readdir(broker.leaseDir), []);
  await assert.rejects(stat(marker), { code: "ENOENT" });
  await broker.decide(pending.request_id, true);
  const { value, error } = await execution;
  assert.ifError(error);
  const result = JSON.parse(value.stdout);
  assert.equal(result.state, "completed");
  assert.equal(result.exit_code, 0);
  assert.equal(result.path, undefined);
  assert.equal(value.stderr, "");
  for (const output of [value.stdout, value.stderr]) {
    assert.ok(!output.includes(DEMO_PASSWORD));
    assert.ok(!output.includes(Buffer.from(DEMO_PASSWORD).toString("base64")));
  }
  const facts = JSON.parse(await readFile(marker, "utf8"));
  assert.equal(facts.length, DEMO_PASSWORD.length);
  assert.equal(facts.ambient, false);
  assert.equal(facts.session, false);
  assert.deepEqual(facts.args, ["literal;argument", "$(literal)"]);
  assert.deepEqual(await readdir(broker.leaseDir), []);
});

test("denied exec never launches its program or creates a file", async (t) => {
  const { runtime, broker } = await setup(t);
  const marker = join(runtime, "should-not-exist");
  const pending = broker.request({
    ...base,
    cwd: runtime,
    argv: [
      process.execPath,
      "-e",
      'require("node:fs").writeFileSync(process.argv[1],"ran")',
      marker,
    ],
  });
  assert.equal((await broker.decide(pending.request_id, false)).state, "denied");
  await assert.rejects(stat(marker), { code: "ENOENT" });
  assert.deepEqual(await readdir(broker.leaseDir), []);
});

test("release stops an approved process and removes its file", async (t) => {
  const { runtime, broker } = await setup(t);
  const marker = join(runtime, "pid.json");
  const pending = broker.request({
    ...base,
    cwd: runtime,
    argv: [
      process.execPath,
      "-e",
      'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,path:process.env.CB_CREDENTIAL_FILE}));setInterval(()=>{},1000)',
      marker,
    ],
  });
  await broker.decide(pending.request_id, true);
  const details = await until(async () => {
    try {
      return JSON.parse(await readFile(marker, "utf8"));
    } catch {}
  });
  assert.equal((await broker.release(pending.request_id)).state, "released");
  await until(async () => {
    try {
      process.kill(details.pid, 0);
    } catch (error) {
      return error.code === "ESRCH";
    }
  });
  await assert.rejects(stat(details.path), { code: "ENOENT" });
});

test(
  "execution timeout kills the program and expires its credential file",
  { timeout: 10_000 },
  async (t) => {
    const { runtime, broker } = await setup(t);
    const marker = join(runtime, "timeout-pid.json");
    const pending = broker.request({
      ...base,
      cwd: runtime,
      argv: [
        process.execPath,
        "-e",
        'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,path:process.env.CB_CREDENTIAL_FILE}));setInterval(()=>{},1000)',
        marker,
      ],
    });
    await broker.decide(pending.request_id, true);
    const details = await until(async () => {
      try {
        return JSON.parse(await readFile(marker, "utf8"));
      } catch {}
    });
    await until(async () => (await broker.status(pending.request_id)).state === "expired");
    await until(async () => {
      try {
        process.kill(details.pid, 0);
      } catch (error) {
        return error.code === "ESRCH";
      }
    });
    await assert.rejects(stat(details.path), { code: "ENOENT" });
  },
);

test("missing approved executable fails with sanitized metadata and cleanup", async (t) => {
  const { runtime, broker } = await setup(t);
  const pending = broker.request({
    ...base,
    cwd: runtime,
    argv: [join(runtime, "absent-program")],
  });
  await broker.decide(pending.request_id, true);
  const result = await until(async () => {
    const r = await broker.status(pending.request_id);
    return r.state === "failed" ? r : false;
  });
  assert.equal(result.path, undefined);
  assert.ok(!JSON.stringify(result).includes(DEMO_PASSWORD));
  assert.deepEqual(await readdir(broker.leaseDir), []);
});

test("file requests cannot smuggle a command; exec cannot overwrite sensitive environment keys", async (t) => {
  const { runtime, broker } = await setup(t);
  const input = { ...base, cwd: runtime, argv: [process.execPath] };
  for (const invalid of [
    { ...input, kind: "file" },
    { ...input, file_env: "BW_SESSION" },
    { ...input, file_env: "PATH" },
    { ...input, argv: [] },
    { ...input, argv: ["node"] },
  ]) {
    assert.throws(() => broker.request(invalid), /Invalid request/);
  }
});

test(
  "broker SIGKILL disconnects the supervisor, stops its program, and removes the file",
  { timeout: 10_000 },
  async (t) => {
    const runtime = await mkdtemp("/tmp/cb-exec-crash-");
    let parent;
    t.after(async () => {
      if (parent?.exitCode === null && !parent.killed) parent.kill("SIGKILL");
      await rm(runtime, { recursive: true, force: true });
    });
    const program =
      'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,path:process.env.CB_CREDENTIAL_FILE}));setInterval(()=>{},1000)';
    const script = `import {Broker} from './src/broker.js';import {DemoProvider,DEMO_ITEM} from './src/providers.js';import {readFile} from 'node:fs/promises';const runtime=process.argv[1];const marker=runtime+'/program.json';const b=new Broker({runtime,provider:new DemoProvider()});await b.initialize();await b.decide(b.request({kind:'exec',item_id:DEMO_ITEM,label:'crash check',reason:'supervisor disconnect',ttl_seconds:5,cwd:runtime,file_env:'CB_CREDENTIAL_FILE',argv:[process.execPath,'-e',${JSON.stringify(program)},marker]}).request_id,true);let text;while(!text){try{text=await readFile(marker,'utf8')}catch{await new Promise(r=>setTimeout(r,20))}}console.log(text);setInterval(()=>{},1000);`;
    parent = spawn(process.execPath, ["--input-type=module", "-e", script, runtime], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: ["ignore", "pipe", "ignore"],
    });
    const details = await new Promise((resolve, reject) => {
      let text = "";
      parent.stdout.on("data", (chunk) => {
        text += chunk;
        if (text.includes("\n")) resolve(JSON.parse(text.trim()));
      });
      parent.once("error", reject);
      parent.once("exit", () => reject(new Error("Crash fixture stopped before program launch.")));
    });
    const exit = new Promise((resolve) => parent.once("exit", resolve));
    parent.kill("SIGKILL");
    await exit;
    await until(async () => {
      try {
        process.kill(details.pid, 0);
      } catch (error) {
        return error.code === "ESRCH";
      }
    });
    await until(async () => {
      try {
        await stat(details.path);
      } catch (error) {
        return error.code === "ENOENT";
      }
    });
  },
);
