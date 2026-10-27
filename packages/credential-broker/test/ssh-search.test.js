import test from "node:test";
import assert from "node:assert/strict";
import { BitwardenProvider, DEMO_ITEM } from "../src/providers.js";
const loginId = "22222222-2222-4222-8222-222222222222";
const keyId = "33333333-3333-4333-8333-333333333333";
const login = (id, name, uris = []) => ({
  id,
  type: 1,
  name,
  login: { username: "Admin", password: "withheld-password", uris: uris.map((uri) => ({ uri })) },
  notes: "withheld-note",
});
const key = {
  id: keyId,
  type: 5,
  name: "Agent key",
  fields: [{ name: "t3-ssh-hosts", type: 0, value: "heihei" }],
  sshKey: { privateKey: "withheld-private-key" },
};
async function vault(t, records) {
  const calls = [];
  let now = 0;
  const provider = new BitwardenProvider({
    now: () => now,
    passwordPrompt: async () => "fake-master",
    runner: async (_, args) => {
      calls.push(args);
      if (args[0] === "unlock") return "fake-session";
      if (args[0] === "list") return JSON.stringify(records);
      if (args[0] === "get") return JSON.stringify(records.find((r) => r.id === args[2]));
      if (args[0] === "edit") throw new Error("unexpected edit");
      return "";
    },
  });
  await provider.initialize();
  t.after(() => provider.close());
  return { provider, calls, advance: () => (now += 30_000) };
}
test("SSH picker ranks bound keys and SSH URL logins ahead of unbound name suggestions", async (t) => {
  const records = [
    login(DEMO_ITEM, "heihei - admin"),
    login(loginId, "Server administrator", ["ssh://admin@heihei:22"]),
    key,
  ];
  const { provider } = await vault(t, records);
  const results = await provider.search("heihei", () => {}, "ssh");
  assert.deepEqual(
    results.map((c) => c.item_id),
    [keyId, loginId, DEMO_ITEM],
  );
  assert.deepEqual(
    results.map((c) => c.kind),
    ["sshKey", "login", "login"],
  );
  assert.equal(results[2].hostMismatch, true);
  assert.equal(results[0].hostMismatch, undefined);
  assert.equal(results[1].hostMismatch, undefined);
  assert.deepEqual(results[1].hosts, ["heihei"]);
  assert.equal(results.diagnostics.hostMatches, 2);
  assert.equal(results.diagnostics.suggestedMatches, 1);
  assert.equal(JSON.stringify(results).includes("withheld"), false);
  await assert.rejects(provider.get(DEMO_ITEM, "ssh", "heihei"), /invalid login/);
});
test("multi-field search normalizes punctuation, accents and pasted URL hosts and ranks matching hosts first", async (t) => {
  const { provider } = await vault(t, [
    login(DEMO_ITEM, "Héihei - Admin"),
    {
      ...login(loginId, "Heihei - Ops", ["https://heihei:8443/login?token=withheld-query"]),
      login: {
        username: "Operator",
        password: "withheld-password",
        uris: [{ uri: "https://heihei:8443/login?token=withheld-query" }],
      },
    },
  ]);
  for (const query of ["HEIHEI admin", "héihei-admin", "admin HEIHEI"]) {
    assert.deepEqual(
      (await provider.searchVault("heihei", query, "ssh")).map((c) => c.item_id),
      [DEMO_ITEM],
    );
  }
  assert.deepEqual(
    (await provider.searchVault("heihei", "https://heihei:8443/login", "ssh")).map(
      (c) => c.item_id,
    ),
    [loginId, DEMO_ITEM],
  );
  assert.deepEqual(await provider.searchVault("heihei", "withheld-password", "ssh"), []);
  assert.deepEqual(await provider.searchVault("heihei", "withheld-query", "ssh"), []);
  assert.deepEqual(await provider.searchVault("heihei", "withheld-note", "ssh"), []);
});
test("combined delivery tags the selected type and rechecks current binding and item type", async (t) => {
  const records = [login(loginId, "Server", ["ssh://admin@heihei"]), key];
  const { provider } = await vault(t, records);
  assert.deepEqual(JSON.parse(await provider.get(loginId, "ssh", "heihei")), {
    type: "login",
    username: "Admin",
    password: "withheld-password",
  });
  assert.deepEqual(JSON.parse(await provider.get(keyId, "ssh", "heihei")), {
    type: "sshKey",
    privateKey: "withheld-private-key\n",
  });
  records[0].login.uris = [];
  await assert.rejects(provider.get(loginId, "ssh", "heihei"), /invalid login/);
  assert.equal(
    JSON.parse(await provider.get(loginId, "ssh", "heihei", { allowHostMismatch: true })).type,
    "login",
  );
  records[1] = { ...records[1], type: 2 };
  await assert.rejects(provider.get(keyId, "ssh", "heihei", { allowHostMismatch: true }));
});
test("metadata cache shares full listings across fields, refreshes after TTL and clears on lock", async (t) => {
  const { provider, calls, advance } = await vault(t, [login(DEMO_ITEM, "heihei - admin"), key]);
  const first = await provider.search("heihei", () => {}, "ssh");
  const second = await provider.searchVault("heihei", "admin", "login");
  assert.equal(first.diagnostics.cacheHit, false);
  assert.equal(second.diagnostics.cacheHit, true);
  assert.equal(calls.filter((c) => c[0] === "list").length, 1);
  advance();
  await provider.search("heihei", () => {}, "ssh");
  assert.equal(calls.filter((c) => c[0] === "list").length, 2);
  await provider.close();
  await assert.rejects(provider.search("heihei", () => {}, "ssh"));
  await provider.initialize();
  await provider.search("heihei", () => {}, "ssh");
  assert.equal(calls.filter((c) => c[0] === "list").length, 3);
});
test("ranking happens before the result limit and diagnostics reveal truncation without query data", async (t) => {
  const records = Array.from({ length: 110 }, (_, i) =>
    login(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, `heihei ${i}`),
  );
  records.push(login(DEMO_ITEM, "Z matched host", ["https://heihei"]));
  const { provider } = await vault(t, records);
  const results = await provider.searchVault("heihei", "", "ssh");
  assert.equal(results.length, 100);
  assert.equal(results[0].item_id, DEMO_ITEM);
  assert.equal(results.diagnostics.truncated, true);
  assert.equal(results.diagnostics.indexedItems, 111);
  assert.equal(JSON.stringify(results.diagnostics).includes("heihei"), false);
});
test("closing while metadata loads prevents a late listing from becoming searchable", async (t) => {
  let resolveList;
  let listed;
  const started = new Promise((resolve) => (listed = resolve));
  const provider = new BitwardenProvider({
    passwordPrompt: async () => "master",
    runner: async (_, args) => {
      if (args[0] === "unlock") return "session";
      if (args[0] === "list") {
        listed();
        return new Promise((resolve) => (resolveList = resolve));
      }
      return "";
    },
  });
  t.after(() => provider.close());
  await provider.initialize();
  const search = provider.search("heihei", () => {}, "ssh");
  await started;
  await provider.close();
  resolveList(JSON.stringify([login(DEMO_ITEM, "heihei")]));
  await assert.rejects(search, /search failed/);
  await assert.rejects(provider.search("heihei", () => {}, "ssh"));
});

test("login search finds SSH URL hostnames without treating them as web host authorization", async (t) => {
  const { provider } = await vault(t, [login(DEMO_ITEM, "Server", ["ssh://admin@heihei"])]);
  const results = await provider.searchVault("heihei", "https://heihei:22/", "login");
  assert.equal(results.length, 1);
  assert.equal(results[0].hostMismatch, true);
  assert.deepEqual(results[0].hosts, ["heihei"]);
  await assert.rejects(provider.get(DEMO_ITEM, "login", "heihei"), /invalid login/);
});

for (const kind of ["login", "sshKey"]) {
  test(`combined always-allow host save updates the selected ${kind} and invalidates cached metadata`, async (t) => {
    let record =
      kind === "login"
        ? login(DEMO_ITEM, "heihei - admin", ["https://old-host"])
        : { ...key, fields: [{ name: "t3-ssh-hosts", type: 0, value: "old-host" }] };
    let lists = 0;
    const provider = new BitwardenProvider({
      passwordPrompt: async () => "master",
      runner: async (_, args, env, timeout, input) => {
        if (args[0] === "unlock") return "session";
        if (args[0] === "list") {
          lists++;
          return JSON.stringify([record]);
        }
        if (args[0] === "get") return JSON.stringify(record);
        if (args[0] === "edit") {
          record = JSON.parse(Buffer.from(input, "base64").toString());
          return JSON.stringify(record);
        }
        return "";
      },
    });
    await provider.initialize();
    t.after(() => provider.close());
    const before = await provider.searchVault("heihei", "", "ssh");
    assert.equal(before[0].hostMismatch, true);
    await provider.addHost(record.id, "ssh", "heihei");
    const after = await provider.search("heihei", () => {}, "ssh");
    assert.equal(after[0].hostMismatch, undefined);
    assert.equal(lists, 2);
    assert.equal(JSON.parse(await provider.get(record.id, "ssh", "heihei")).type, kind);
    assert.ok(
      (kind === "login"
        ? record.login.uris.map((uri) => uri.uri).join(" ")
        : record.fields[0].value
      ).includes("old-host"),
    );
  });
}

test("locking also cancels an in-flight cached lookup", async (t) => {
  const { provider } = await vault(t, [login(DEMO_ITEM, "heihei")]);
  await provider.search("heihei");
  const cached = provider.search("heihei");
  await provider.close();
  await assert.rejects(cached, /search failed/);
});

for (const kind of ["login", "sshKey"]) {
  test(`${kind} wildcard bindings suggest subdomains without authorizing delivery`, async (t) => {
    const record =
      kind === "login"
        ? login(DEMO_ITEM, "Infrastructure", ["https://*.example.com:8443/login"])
        : { ...key, fields: [{ name: "t3-ssh-hosts", type: 0, value: "*.example.com" }] };
    const { provider } = await vault(t, [record]);
    for (const site of ["app.example.com", "nested.app.example.com"]) {
      const results = await provider.search(site, () => {}, "ssh");
      assert.equal(results.length, 1);
      assert.equal(results[0].hostMismatch, true);
      assert.equal(results[0].matchReason, "wildcard");
      assert.deepEqual(results[0].hosts, ["*.example.com"]);
      await assert.rejects(provider.get(record.id, "ssh", site));
      assert.equal(
        JSON.parse(await provider.get(record.id, "ssh", site, { allowHostMismatch: true })).type,
        kind,
      );
    }
    for (const site of ["example.com", "evil-example.com", "app.example.com.evil.test"]) {
      assert.deepEqual(await provider.search(site, () => {}, "ssh"), []);
    }
  });
}

for (const [site, saved] of [
  ["heihei", "heihei.tailnet.ts.net"],
  ["heihei.tailnet.ts.net", "heihei"],
]) {
  test(`short-host suggestion ${site} from ${saved} requires confirmation`, async (t) => {
    const { provider } = await vault(t, [login(DEMO_ITEM, "Infrastructure", [`ssh://${saved}`])]);
    const results = await provider.search(site, () => {}, "ssh");
    assert.equal(results.length, 1);
    assert.equal(results[0].matchReason, "shortHost");
    assert.equal(results[0].hostMismatch, true);
    await assert.rejects(provider.get(DEMO_ITEM, "ssh", site));
  });
}

test("short-host suggestions do not equate different FQDNs or numeric address prefixes", async (t) => {
  const { provider } = await vault(t, [
    login(DEMO_ITEM, "Infrastructure", ["ssh://heihei.other.test", "ssh://127.0.0.1"]),
  ]);
  for (const site of ["heihei.tailnet.ts.net", "127", "hei"])
    assert.deepEqual(await provider.search(site, () => {}, "ssh"), []);
});

test("exact bindings outrank alias and wildcard suggestions, including in explicit search", async (t) => {
  const { provider } = await vault(t, [
    login(DEMO_ITEM, "Heihei wildcard", ["https://*.tailnet.ts.net"]),
    login(loginId, "Heihei short", ["https://heihei"]),
    {
      ...key,
      name: "Heihei key",
      fields: [{ name: "t3-ssh-hosts", type: 0, value: "heihei.tailnet.ts.net" }],
    },
  ]);
  for (const query of [undefined, "heihei"]) {
    const results = await provider.search("heihei.tailnet.ts.net", () => {}, "ssh", query);
    assert.deepEqual(
      results.map((c) => c.item_id),
      [keyId, loginId, DEMO_ITEM],
    );
    assert.equal(results[0].matchReason, undefined);
    assert.equal(results[0].hostMismatch, undefined);
    assert.equal(results.diagnostics.hostMatches, 1);
    assert.equal(results.diagnostics.suggestedMatches, 2);
  }
});

test("unsupported wildcard forms and Never-match URIs cannot authorize or suggest hosts", async (t) => {
  const record = login(DEMO_ITEM, "Infrastructure", [
    "https://foo*.example.com",
    "https://**.example.com",
    "https://*.*.example.com",
  ]);
  record.login.uris.push({ uri: "https://*.allowed.test", match: 5 });
  const { provider } = await vault(t, [record]);
  for (const site of ["foo.example.com", "bar.example.com", "app.allowed.test"]) {
    assert.deepEqual(await provider.search(site, () => {}, "ssh"), []);
    await assert.rejects(provider.get(DEMO_ITEM, "ssh", site));
  }
});
