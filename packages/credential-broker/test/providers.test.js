import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BitwardenProvider, DEMO_ITEM } from "../src/providers.js";

test("real child failures explain unlock rejection without leaking provider stderr", async (t) => {
  const directory = await mkdtemp("/tmp/cb-provider-error-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "fake-bw");
  await writeFile(
    executable,
    '#!/bin/sh\necho "Invalid master password: test-secret-must-stay-private" >&2\nexit 1\n',
    { mode: 0o700 },
  );
  const provider = new BitwardenProvider({
    executable,
    passwordPrompt: async () => "fake-master",
  });
  await assert.rejects(provider.initialize(), (error) => {
    assert.equal(error.message, "Bitwarden did not accept the master password.");
    assert.ok(!String(error).includes("test-secret-must-stay-private"));
    assert.ok(!String(error).includes("fake-master"));
    return true;
  });
});

test("Bitwarden master password and session use private child env, never argv", async () => {
  const calls = [];
  const master = "test-master";
  const session = "test-vault-session";
  const password = "test-item-password";
  const provider = new BitwardenProvider({
    env: { PATH: "/usr/bin", BW_SESSION: "inherited-must-be-ignored" },
    passwordPrompt: async () => `${master}\n`,
    runner: async (bin, args, env) => {
      calls.push({ bin, args, env });
      if (args[0] === "unlock") {
        assert.equal(env[args[3]], master);
        return `${session}\n`;
      }
      if (args[0] === "get") {
        assert.equal(env.BW_SESSION, session);
        return JSON.stringify({ id: DEMO_ITEM, type: 1, login: { password } });
      }
      return "";
    },
  });
  await provider.initialize();
  assert.equal(await provider.get(DEMO_ITEM, "password"), password);
  await provider.close();
  assert.deepEqual(
    calls.map((c) => c.args[0]),
    ["unlock", "get", "lock"],
  );
  for (const call of calls) {
    assert.ok(!JSON.stringify(call.args).includes(master));
    assert.ok(!JSON.stringify(call.args).includes(session));
    assert.ok(!JSON.stringify(call.args).includes(password));
    if (call.args[0] !== "unlock") assert.ok(!Object.values(call.env).includes(master));
  }
  await assert.rejects(provider.get(DEMO_ITEM, "password"), /locked/);
});

test("Bitwarden adapter rejects wrong item IDs and non-login records", async () => {
  let record = {
    id: "different-id",
    type: 1,
    login: { password: "do-not-return" },
  };
  const provider = new BitwardenProvider({
    passwordPrompt: async () => "test",
    runner: async (_, args) => (args[0] === "unlock" ? "session" : JSON.stringify(record)),
  });
  await provider.initialize();
  await assert.rejects(provider.get(DEMO_ITEM, "password"), /invalid login/);
  record = { id: DEMO_ITEM, type: 2, login: { password: "do-not-return" } };
  await assert.rejects(provider.get(DEMO_ITEM, "password"), /invalid login/);
  await provider.close();
});

test("Bitwarden creates host-bound logins through stdin and returns only selection metadata", async () => {
  const calls = [];
  const provider = new BitwardenProvider({
    passwordPrompt: async () => "fake-master",
    runner: async (_, args, env, timeout, input) => {
      calls.push({ args, env, timeout, input });
      if (args[0] === "unlock") return "fake-session";
      if (args[0] === "create") {
        const item = JSON.parse(Buffer.from(input, "base64").toString());
        assert.equal(item.login.username, "test-user");
        assert.equal(item.login.password, "test-password");
        assert.deepEqual(item.login.uris, [{ uri: "https://tower", match: 0 }]);
        return JSON.stringify({ ...item, id: DEMO_ITEM });
      }
      return "";
    },
  });
  await provider.initialize();
  assert.deepEqual(
    await provider.create("tower", { username: "test-user", password: "test-password" }),
    {
      item_id: DEMO_ITEM,
      name: "tower (test-user)",
      username: "test-user",
      hosts: ["tower"],
    },
  );
  const call = calls.find((c) => c.args[0] === "create");
  assert.deepEqual(call.args, ["create", "item"]);
  assert.equal(call.env.BW_SESSION, "fake-session");
  assert.equal(Object.values(call.env).includes("test-password"), false);
  await provider.close();
  await assert.rejects(provider.create("tower", { username: "", password: "test" }), /locked/);
});

test("Bitwarden save errors and invalid responses never expose provider output", async () => {
  let response;
  const provider = new BitwardenProvider({
    passwordPrompt: async () => "test",
    runner: async (_, args) => {
      if (args[0] === "unlock") return "session";
      if (response instanceof Error) throw response;
      return JSON.stringify(response);
    },
  });
  await provider.initialize();
  for (response of [
    new Error("private-secret"),
    { id: DEMO_ITEM, type: 1, login: { uris: [{ uri: "https://other" }] } },
  ]) {
    await assert.rejects(
      provider.create("tower", { username: "test", password: "private-secret" }),
      (error) => {
        assert.equal(
          error.message,
          "Could not confirm the saved login. Check Bitwarden before retrying.",
        );
        return true;
      },
    );
  }
});

test("real Bitwarden child receives encoded new login only on stdin", async (t) => {
  const directory = await mkdtemp("/tmp/cb-provider-save-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "fake-bw");
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'unlock') process.stdout.write('fake-session');
else if (args[0] === 'create') {
  if (JSON.stringify(args) !== JSON.stringify(['create', 'item'])) process.exit(2);
  const item = JSON.parse(Buffer.from(fs.readFileSync(0, 'utf8'), 'base64').toString());
  if (item.login.password !== 'fake-site-password') process.exit(3);
  process.stdout.write(JSON.stringify({...item, id: '${DEMO_ITEM}'}));
}
`,
    { mode: 0o700 },
  );
  const provider = new BitwardenProvider({ executable, passwordPrompt: async () => "fake-master" });
  await provider.initialize();
  assert.deepEqual(
    await provider.create("tower", { username: "", password: "fake-site-password" }),
    {
      item_id: DEMO_ITEM,
      name: "tower",
      hosts: ["tower"],
    },
  );
  await provider.close();
});

test("vault unlock requires the T3 password callback and never starts a native prompt", async () => {
  let started = false;
  const provider = new BitwardenProvider({
    runner: async () => {
      started = true;
      return "fake-session";
    },
  });
  await assert.rejects(provider.initialize(), /Unlock the vault through Credential access in T3/);
  assert.equal(started, false);
});
