// Graphical-host integration test. Debugging is enabled only for this fake vault.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { chromium } from "playwright-core";
import { DesktopPresenter } from "../src/desktop-presenter.js";
import { Broker } from "../src/broker.js";
import { DemoProvider, DEMO_PASSWORD } from "../src/providers.js";
import { startServers } from "../src/server.js";

const output = process.env.CB_QA_ARTIFACTS ? resolve(process.env.CB_QA_ARTIFACTS) : undefined;
if (output) await mkdir(output, { recursive: true });
const runtime = await mkdtemp(join(tmpdir(), "cb-electron-test-"));
const reserved = net.createServer();
await new Promise((resolve) => reserved.listen(0, "127.0.0.1", resolve));
const port = reserved.address().port;
await new Promise((resolve) => reserved.close(resolve));
const desktop = new DesktopPresenter({
  spawnProcess: (exe, args, options) =>
    spawn(exe, [`--remote-debugging-port=${port}`, ...args], options),
});
const broker = new Broker({
  runtime,
  provider: new DemoProvider(),
  approver: desktop.approve.bind(desktop),
  notifier: desktop,
});
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
let servers, browser, publisher;
const callers = [];
async function until(predicate, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error(message);
}
async function screenshot(page, name) {
  if (output) await page.screenshot({ path: join(output, `${name}.png`) });
}
function caller(script) {
  const child = spawn(
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
      "Sign in to example.com",
      "--reason",
      "Complete the requested sign-in.",
      "--client",
      "Desktop QA",
      "--ttl",
      "60",
      "--",
      process.execPath,
      script,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let raw = "";
  child.stdout.on("data", (chunk) => (raw += chunk));
  child.stderr.on("data", (chunk) => (raw += chunk));
  const done = new Promise((resolve) => child.once("exit", (code) => resolve({ code, raw })));
  callers.push(child);
  return { child, done };
}
try {
  await desktop.start();
  await broker.initialize();
  servers = await startServers(broker, {
    port: 0,
    host: "127.0.0.1",
    publicUrl: "http://test.invalid",
  });
  desktop.onAction = (action, id) => {
    if (action === "revoke") void broker.revokeGrant(id);
    if (action === "release") void broker.release(id);
  };
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  context.on("page", (page) =>
    page.on("pageerror", (error) => console.error("Desktop renderer error:", error.message)),
  );
  context.on("page", (page) =>
    page.on("console", (message) => {
      if (message.type() === "error") console.error("Desktop console:", message.text());
    }),
  );
  const nextPage = () => context.waitForEvent("page");
  const publish = async () =>
    desktop.state({
      status: "ready",
      runtime,
      grants: broker.grants.list(),
      requests: await broker.list(),
    });
  let next = nextPage();
  await publish();
  const dashboard = await next;
  await dashboard.getByText("Access, on your terms.").waitFor();
  await screenshot(dashboard, "desktop-empty-permissions");
  publisher = setInterval(() => void publish(), 300);
  const script = join(runtime, "consumer.mjs");
  const marker = join(runtime, "pids.txt");
  await writeFile(
    script,
    `import fs from 'node:fs';const login=JSON.parse(fs.readFileSync(process.env.CB_CREDENTIAL_FILE,'utf8'));if(!login.username||!login.password)process.exit(1);fs.appendFileSync(${JSON.stringify(marker)},process.pid+'\\n');setInterval(()=>{},1000);`,
  );
  next = nextPage();
  const first = caller(script);
  const approval = await next;
  await approval.getByRole("button", { name: "Always allow", exact: true }).waitFor();
  assert.deepEqual(await readdir(broker.leaseDir), []);
  assert.equal(await approval.evaluate(() => typeof process), "undefined");
  assert.equal(
    await approval.evaluate(async () => {
      try {
        await window.brokerDesktop.act("release", "fake");
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  await screenshot(approval, "desktop-approval");
  await approval.getByText("Review exact command & scope").click();
  await screenshot(approval, "desktop-command-details");
  await approval.getByRole("button", { name: "Always allow", exact: true }).click();
  await until(
    async () => (await broker.list()).filter((r) => r.state === "running").length === 1,
    "First command did not run",
  );
  assert.equal(broker.grants.list().length, 1);
  await publish();
  await screenshot(dashboard, "desktop-published-permissions");
  await dashboard.getByRole("button", { name: "Revoke", exact: true }).waitFor();
  await screenshot(dashboard, "desktop-active-permissions");
  next = nextPage();
  const second = caller(script);
  const toast = await next;
  await toast.getByText("Automatically approved", { exact: true }).waitFor();
  await until(
    async () => (await broker.list()).filter((r) => r.state === "running").length === 2,
    "Automatic command did not run",
  );
  const notice = broker.notices()[0];
  assert.equal(notice.expires_at - notice.created_at, 300000);
  assert.ok(notice.expires_at - Date.now() > 290000);
  await screenshot(toast, "desktop-automatic-use");
  await toast.getByRole("button", { name: "Dismiss", exact: true }).click();
  await until(() => broker.notices().length === 0, "Dismiss did not hide notice");
  assert.equal(broker.grants.list().length, 1);
  assert.equal((await broker.list()).filter((r) => r.state === "running").length, 2);
  next = nextPage();
  const third = caller(script);
  const revokeToast = await next;
  await until(
    async () => (await broker.list()).filter((r) => r.state === "running").length === 3,
    "Third automatic command did not run",
  );
  await revokeToast.getByRole("button", { name: "Revoke & stop" }).click();
  await revokeToast.getByText("Access revoked", { exact: true }).waitFor();
  await screenshot(revokeToast, "desktop-revoked");
  for (const invocation of [first, second, third]) {
    const result = await invocation.done;
    assert.equal(result.code, 125);
    assert.equal(JSON.parse(result.raw).state, "revoked");
    assert.ok(!result.raw.includes(DEMO_PASSWORD));
  }
  assert.equal(broker.grants.list().length, 0);
  assert.deepEqual(await readdir(broker.leaseDir), []);
  const pids = (await readFile(marker, "utf8")).trim().split("\n").map(Number);
  await until(
    () =>
      pids.every((pid) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          return error.code === "ESRCH";
        }
      }),
    "Credential consumers survived revocation",
  );
  await revokeToast.getByRole("button", { name: "Dismiss", exact: true }).click();
  // A separate unsupervised file request has no Always allow action.
  next = nextPage();
  const file = broker.request({
    site: "example.com",
    field: "login",
    label: "Compatibility login",
    reason: "Check compatibility approval",
    ttl_seconds: 60,
  });
  const fileApproval = await next;
  await fileApproval.getByRole("button", { name: "Allow once", exact: true }).waitFor();
  assert.equal(
    await fileApproval.getByRole("button", { name: "Always allow", exact: true }).count(),
    0,
  );
  await screenshot(fileApproval, "desktop-file-approval");
  await fileApproval.getByRole("button", { name: "Deny", exact: true }).click();
  await until(
    async () => (await broker.status(file.request_id)).state === "denied",
    "File denial failed",
  );
  next = nextPage();
  const unlock = desktop.unlock();
  const unlockPage = await next;
  await unlockPage.getByLabel("MASTER PASSWORD").waitFor();
  await screenshot(unlockPage, "desktop-private-unlock");
  assert.equal(
    await unlockPage.evaluate(async () => {
      try {
        await window.brokerDesktop.act("always", "fake");
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  await unlockPage.getByLabel("MASTER PASSWORD").fill("FAKE-ONLY-UNLOCK");
  await unlockPage.getByRole("button", { name: "Unlock vault" }).click();
  assert.equal(await unlock, "FAKE-ONLY-UNLOCK");
  // Cancellation closes the actual approval window and prevents late delivery.
  next = nextPage();
  const cancelled = broker.request({
    site: "example.com",
    field: "login",
    label: "Cancel example login",
    reason: "Check cancellation",
    ttl_seconds: 60,
  });
  const cancelledPage = await next;
  await cancelledPage.getByRole("button", { name: "Deny", exact: true }).waitFor();
  await broker.release(cancelled.request_id);
  await until(() => cancelledPage.isClosed(), "Cancelled dialog remained open");
  assert.deepEqual(await readdir(broker.leaseDir), []);
  // Role checks prevent a permission window from granting a new request.
  assert.equal(
    await dashboard.evaluate(async () => {
      try {
        await window.brokerDesktop.act("once", "fake");
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  assert.equal(await dashboard.evaluate(() => typeof require), "undefined");
  await publish();
  await dashboard.getByText(/No standing permissions/).waitFor();
  await screenshot(dashboard, "desktop-permissions-cleared");
  console.log(
    "Desktop integration passed: approval, scope inspection, grant, auto-use, 300s deadline, dismissal, native revoke, three CLI exits 125, consumer death, file cleanup, file denial, private unlock, cancellation, and IPC role isolation.",
  );
} catch (error) {
  console.error(
    "Desktop QA failure state:",
    JSON.stringify({
      requests: (await broker.list()).map((r) => ({
        state: r.state,
        auto: r.auto_approved,
        error: r.error,
      })),
      grants: broker.grants.list().length,
      notices: broker.notices().length,
      pages: browser
        ?.contexts()[0]
        ?.pages()
        .map((p) => p.url()),
    }),
  );
  throw error;
} finally {
  clearInterval(publisher);
  for (const child of callers) if (child.exitCode === null) child.kill("SIGTERM");
  if (servers) await servers.close();
  await broker.close();
  await browser?.close();
  desktop.close();
  await rm(runtime, { recursive: true, force: true });
}
