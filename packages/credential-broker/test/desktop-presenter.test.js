import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { DesktopPresenter } from "../src/desktop-presenter.js";

function harness() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.exitCode = null;
  child.kill = () => child.emit("exit", 1);
  const messages = [];
  let spawnOptions;
  child.stdin.on("data", (chunk) => {
    const value = JSON.parse(chunk.toString());
    messages.push(value);
    if (value.command === "ready") queueMicrotask(() => reply(value.id, true));
  });
  function reply(id, value) {
    child.stdout.write(JSON.stringify({ event: "response", id, value }) + "\n");
  }
  const desktop = new DesktopPresenter({
    executable: "/fake/electron",
    spawnProcess: (_exe, _args, options) => {
      spawnOptions = options;
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  return { desktop, child, messages, reply, options: () => spawnOptions };
}
const request = {
  kind: "exec",
  item_id: "11111111-1111-4111-8111-111111111111",
  approval_deadline: Date.now() + 120000,
};
async function sent(h, command) {
  for (let i = 0; i < 20; i++) {
    const message = h.messages.find((m) => m.command === command);
    if (message) return message;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw Error("Expected presenter message");
}

test("desktop launch isolates output and removes ambient credential variables", async () => {
  process.env.CB_FAKE_TOKEN = "fake-not-real";
  const h = harness();
  try {
    await h.desktop.start();
    assert.deepEqual(h.options().stdio, ["pipe", "pipe", "ignore"]);
    assert.equal(h.options().env.CB_FAKE_TOKEN, undefined);
    assert.equal(h.options().env.ELECTRON_RUN_AS_NODE, undefined);
  } finally {
    delete process.env.CB_FAKE_TOKEN;
    h.desktop.close();
  }
});

test("desktop approval only accepts the selected candidate and supervised always allow", async () => {
  const h = harness();
  try {
    const promise = h.desktop.approve(request);
    const message = await sent(h, "approve");
    h.reply(message.id, { approve: true, item_id: "wrong-item" });
    await assert.rejects(promise, /Invalid desktop approval/);
    h.messages.length = 0;
    const file = h.desktop.approve({ ...request, kind: "file" });
    const next = await sent(h, "approve");
    h.reply(next.id, { approve: true, item_id: request.item_id, always: true });
    await assert.rejects(file, /Invalid desktop approval/);
  } finally {
    h.desktop.close();
  }
});

test("cancelled approval closes its dialog and late approval cannot resolve it", async () => {
  const h = harness();
  const controller = new AbortController();
  try {
    const promise = h.desktop.approve(request, { signal: controller.signal });
    const message = await sent(h, "approve");
    controller.abort();
    await assert.rejects(promise, /cancelled/);
    assert.ok(h.messages.some((m) => m.command === "cancel" && m.id === message.id));
    h.reply(message.id, { approve: true, item_id: request.item_id });
  } finally {
    h.desktop.close();
  }
});

test("notice delivery requires a visible acknowledgment; crash interrupts automatic consumers", async () => {
  const h = harness();
  const actions = [];
  try {
    let delivered = false;
    const promise = h.desktop
      .show({ notice_id: "fake-notice" }, (action) => actions.push(action))
      .then(() => {
        delivered = true;
      });
    const message = await sent(h, "notice");
    assert.equal(delivered, false);
    h.reply(message.id, true);
    await promise;
    assert.equal(delivered, true);
    h.child.emit("exit", 1);
    assert.deepEqual(actions, ["failed"]);
  } finally {
    h.desktop.close();
  }
});

test("failed notice acknowledgment does not retain an automatic consumer callback", async () => {
  const h = harness();
  const actions = [];
  try {
    const promise = h.desktop.show({ notice_id: "fake-notice" }, (action) => actions.push(action));
    const message = await sent(h, "notice");
    h.reply(message.id, false);
    await assert.rejects(promise, /did not appear/);
    h.child.emit("exit", 1);
    assert.deepEqual(actions, []);
  } finally {
    h.desktop.close();
  }
});

test("dismissal retains the grant decision but removes crash tracking for that notice", async () => {
  const h = harness();
  const actions = [];
  try {
    const promise = h.desktop.show({ notice_id: "fake-notice" }, (action) => actions.push(action));
    const message = await sent(h, "notice");
    h.reply(message.id, true);
    await promise;
    h.child.stdout.write(JSON.stringify({ event: "dismiss", notice_id: "fake-notice" }) + "\n");
    assert.deepEqual(actions, ["dismiss"]);
    h.desktop.dismiss("fake-notice");
    h.child.emit("exit", 1);
    assert.deepEqual(actions, ["dismiss"]);
  } finally {
    h.desktop.close();
  }
});

test("private unlock is bounded and cancellation never yields a password", async () => {
  const h = harness();
  try {
    const promise = h.desktop.unlock();
    const message = await sent(h, "unlock");
    h.reply(message.id, {});
    await assert.rejects(promise, /cancelled/);
  } finally {
    h.desktop.close();
  }
});
