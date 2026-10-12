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
