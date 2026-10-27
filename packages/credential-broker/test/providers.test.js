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

test("SSH search selects only explicitly bound SSH items and rechecks bindings at delivery", async () => {
  const privateKey = "fake-private-key-material";
  const calls = [];
  let current = {
    id: DEMO_ITEM,
    type: 5,
    name: "Production SSH key",
    fields: [
      { name: "t3-ssh-hosts", type: 0, value: "other.example.com, TOWER.example.com\nlocal-host" },
    ],
    sshKey: { privateKey, publicKey: "fake-public-key", keyFingerprint: "fake-fingerprint" },
    notes: "private-note",
  };
  const provider = new BitwardenProvider({
    passwordPrompt: async () => "fake-master",
    runner: async (_, args) => {
      calls.push(args);
      if (args[0] === "unlock") return "fake-session";
      if (args[0] === "list")
        return JSON.stringify([
          current,
          { ...current, type: 1 },
          { ...current, deletedDate: "today" },
          { ...current, fields: [] },
          { ...current, fields: [{ name: "t3-ssh-hosts", type: 1, value: "tower.example.com" }] },
          {
            ...current,
            fields: [
              {
                name: "t3-ssh-hosts",
                type: 0,
                value: "sibling.example.com tower.example.com.evil.test",
              },
            ],
          },
        ]);
      if (args[0] === "get") return JSON.stringify(current);
      return "";
    },
  });
  await provider.initialize();
  const matches = await provider.search("tower.example.com", () => {}, "sshKey");
  assert.deepEqual(matches, [
    { item_id: DEMO_ITEM, name: "Production SSH key", hosts: ["tower.example.com"] },
  ]);
  assert.deepEqual(calls[2], ["list", "items", "--raw"]);
  assert.equal(JSON.stringify(matches).includes(privateKey), false);
  assert.equal(JSON.stringify(matches).includes("private-note"), false);
  assert.equal(await provider.get(DEMO_ITEM, "sshKey", "tower.example.com"), `${privateKey}\n`);
  assert.equal((await provider.search("local-host", () => {}, "sshKey")).length, 1);
  assert.deepEqual(await provider.search("sub.tower.example.com", () => {}, "sshKey"), []);
  assert.deepEqual(await provider.search("tower.example.com"), []);
  current = { ...current, fields: [] };
  await assert.rejects(provider.get(DEMO_ITEM, "sshKey", "tower.example.com"), /invalid SSH key/);
  current = {
    ...current,
    fields: [{ name: "t3-ssh-hosts", type: 0, value: "tower.example.com" }],
    deletedDate: "today",
  };
  await assert.rejects(provider.get(DEMO_ITEM, "sshKey", "tower.example.com"), /invalid SSH key/);
  current = { ...current, deletedDate: null, sshKey: { privateKey: "" } };
  await assert.rejects(
    provider.get(DEMO_ITEM, "sshKey", "tower.example.com"),
    /private key is empty/,
  );
  await provider.close();
});

test("manual vault search finds saved names, usernames and hosts without revealing or searching secrets", async () => {
  const calls = [];
  let now = 0;
  let record = {
    id: DEMO_ITEM,
    type: 1,
    name: "Home server",
    login: {
      username: "Cheruvian",
      password: "private-password",
      uris: [{ uri: "https://wrong.example.com/path?secret=private-query" }],
    },
    notes: "private-note",
  };
  const provider = new BitwardenProvider({
    now: () => now,
    passwordPrompt: async () => "fake-master",
    runner: async (_, args) => {
      calls.push(args);
      if (args[0] === "unlock") return "fake-session";
      if (args[0] === "list")
        return JSON.stringify([
          record,
          { ...record, deletedDate: "today" },
          { ...record, type: 2 },
        ]);
      if (args[0] === "get") return JSON.stringify(record);
      return "";
    },
  });
  await provider.initialize();
  for (const query of ["", "HOME", "cheruvian", "wrong.example.com", "home cheruvian"]) {
    const matches = await provider.searchVault("heihei", query, "password");
    assert.deepEqual(matches, [
      {
        item_id: DEMO_ITEM,
        name: "Home server",
        username: "Cheruvian",
        hosts: ["wrong.example.com"],
        hostMismatch: true,
      },
    ]);
  }
  assert.deepEqual(
    calls.find((args) => args[0] === "list"),
    ["list", "items", "--raw"],
  );
  for (const query of ["private-password", "private-note", "private-query", "missing"])
    assert.deepEqual(await provider.searchVault("heihei", query, "password"), []);
  await assert.rejects(provider.get(DEMO_ITEM, "password", "heihei"), /invalid login/);
  assert.equal(
    await provider.get(DEMO_ITEM, "password", "heihei", { allowHostMismatch: true }),
    "private-password",
  );
  record = { ...record, deletedDate: "today" };
  await assert.rejects(
    provider.get(DEMO_ITEM, "password", "heihei", { allowHostMismatch: true }),
    /invalid login/,
  );
  record = {
    ...record,
    deletedDate: null,
    type: 5,
    fields: [],
    sshKey: { privateKey: "private-ssh-key" },
  };
  await assert.rejects(
    provider.get(DEMO_ITEM, "password", "heihei", { allowHostMismatch: true }),
    /invalid login/,
  );
  now = 30_000;
  assert.deepEqual(await provider.searchVault("heihei", "home", "sshKey"), [
    { item_id: DEMO_ITEM, name: "Home server", hosts: [], hostMismatch: true },
  ]);
  assert.equal(
    await provider.get(DEMO_ITEM, "sshKey", "heihei", { allowHostMismatch: true }),
    "private-ssh-key\n",
  );
  await provider.close();
});

for (const field of ["password", "sshKey"]) {
  test(`saving a host on ${field} preserves existing hosts and secrets and edits through stdin`, async () => {
    let record = {
      id: DEMO_ITEM,
      type: field === "sshKey" ? 5 : 1,
      name: "Saved credential",
      notes: "private-note",
      fields: [
        { name: "other-field", type: 1, value: "private-field" },
        { name: "t3-ssh-hosts", type: 0, value: "old-host" },
      ],
      login: {
        username: "private-user",
        password: "private-password",
        uris: [{ uri: "https://old-host", match: 0 }],
      },
      sshKey: {
        privateKey: "private-key",
        publicKey: "public-key",
        keyFingerprint: "test-fingerprint",
      },
    };
    const original = structuredClone(record);
    const edits = [];
    const provider = new BitwardenProvider({
      passwordPrompt: async () => "fake-master",
      runner: async (_, args, env, _timeout, input) => {
        if (args[0] === "unlock") return "fake-session";
        if (args[0] === "get") return JSON.stringify(record);
        if (args[0] === "edit") {
          assert.equal(env.BW_SESSION, "fake-session");
          assert.deepEqual(args, ["edit", "item", DEMO_ITEM]);
          record = JSON.parse(Buffer.from(input, "base64").toString());
          edits.push(args);
          return JSON.stringify(record);
        }
        return "";
      },
    });
    await provider.initialize();
    assert.deepEqual((await provider.addHost(DEMO_ITEM, field, "heihei")).hosts, [
      "old-host",
      "heihei",
    ]);
    assert.equal(record.notes, original.notes);
    assert.equal(record.login.password, original.login.password);
    assert.deepEqual(record.sshKey, original.sshKey);
    assert.deepEqual(record.fields[0], original.fields[0]);
    assert.equal(
      await provider.get(DEMO_ITEM, field, "heihei"),
      field === "sshKey" ? "private-key\n" : "private-password",
    );
    await provider.addHost(DEMO_ITEM, field, "heihei");
    assert.equal(edits.length, 1);
    await provider.close();
  });
}

test("saving an SSH host creates its missing binding field without losing other custom fields", async () => {
  let record = {
    id: DEMO_ITEM,
    type: 5,
    fields: [{ name: "other", value: "keep", type: 0 }],
    sshKey: { privateKey: "private-key" },
  };
  const provider = new BitwardenProvider({
    passwordPrompt: async () => "fake-master",
    runner: async (_, args, _env, _timeout, input) => {
      if (args[0] === "unlock") return "fake-session";
      if (args[0] === "edit") record = JSON.parse(Buffer.from(input, "base64").toString());
      return JSON.stringify(record);
    },
  });
  await provider.initialize();
  await provider.addHost(DEMO_ITEM, "sshKey", "heihei");
  assert.deepEqual(record.fields, [
    { name: "other", value: "keep", type: 0 },
    { name: "t3-ssh-hosts", value: "heihei", type: 0 },
  ]);
  await provider.close();
});

test("host save rejects invalid items and unconfirmed writes without exposing provider output", async () => {
  let record = { id: DEMO_ITEM, type: 1, login: { password: "private-password", uris: [] } };
  let editFails = false;
  const provider = new BitwardenProvider({
    passwordPrompt: async () => "fake-master",
    runner: async (_, args) => {
      if (args[0] === "unlock") return "fake-session";
      if (args[0] === "edit" && editFails) throw new Error("private-provider-error");
      return JSON.stringify(record);
    },
  });
  await provider.initialize();
  for (const scenario of ["unconfirmed", "provider-error", "deleted", "wrong-type", "wrong-id"]) {
    record = {
      id: scenario === "wrong-id" ? "wrong-id" : DEMO_ITEM,
      type: scenario === "wrong-type" ? 5 : 1,
      login: { password: "private-password", uris: [] },
      ...(scenario === "deleted" ? { deletedDate: "today" } : {}),
    };
    editFails = scenario === "provider-error";
    await assert.rejects(provider.addHost(DEMO_ITEM, "password", "heihei"), (error) => {
      assert.equal(error.message, "Could not confirm the saved host in Bitwarden.");
      return true;
    });
  }
  await provider.close();
});
