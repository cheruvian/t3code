import test from "node:test";
import assert from "node:assert/strict";
import { AccountProvider } from "../src/accounts.js";

function vault(value) {
  return {
    initialize: async () => {},
    close: async () => {},
    search: async () => [{ item_id: "same-id", name: "Login", hosts: ["example.com"] }],
    searchVault: async () => [{ item_id: "same-id", name: "Login", hosts: ["example.com"] }],
    get: async (id) => {
      assert.equal(id, "same-id");
      return value;
    },
    addHost: async (id) => {
      assert.equal(id, "same-id");
      return { hosts: ["example.com"] };
    },
    create: async () => ({ item_id: "same-id", name: "New", hosts: ["example.com"] }),
  };
}

test("separate accounts with identical item IDs resolve only in their own vault", async () => {
  const provider = new AccountProvider();
  await provider.add("personal", vault("personal-secret"));
  await provider.add("work", vault("work-secret"));
  const candidates = await provider.search("example.com");
  assert.equal(candidates.length, 2);
  assert.notEqual(candidates[0].item_id, candidates[1].item_id);
  assert.match(candidates[0].name, /personal/);
  assert.equal(await provider.get(candidates[0].item_id), "personal-secret");
  assert.equal(await provider.get(candidates[1].item_id), "work-secret");
  await assert.rejects(provider.get("same-id"));
  await assert.rejects(provider.create("example.com", {}), /Choose an account/);
  const saved = await provider.create("example.com", { account: "work" });
  assert.equal(await provider.get(saved.item_id), "work-secret");
  await assert.rejects(provider.create("example.com", { account: "missing" }));
  await provider.close();
  await assert.rejects(provider.get(candidates[0].item_id));
});

test("failed account unlock leaves existing accounts available", async () => {
  const provider = new AccountProvider();
  await provider.add("personal", vault("secret"));
  await assert.rejects(
    provider.add("work", {
      ...vault("other"),
      initialize: async () => {
        throw new Error("locked");
      },
    }),
  );
  assert.deepEqual(provider.accounts, ["personal"]);
  assert.equal((await provider.search("example.com")).length, 1);
  await assert.rejects(provider.add("personal", vault("replacement")));
});

test("host unlocks two CLI profiles and locking clears both accounts", async () => {
  const { mkdtemp, mkdir, writeFile, rm, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { T3CredentialBroker } = await import("../src/t3.js");
  const root = await mkdtemp(join(tmpdir(), "broker-accounts-"));
  const runtime = join(root, "runtime");
  await mkdir(runtime, { mode: 0o700 });
  const executable = join(root, "bw");
  await writeFile(
    executable,
    `#!${process.execPath}\nif (process.argv[2] === "unlock") process.stdout.write("fake-session");\n`,
    { mode: 0o700 },
  );
  const broker = new T3CredentialBroker({ runtime, watchdog: false });
  try {
    await broker.action("human", {
      type: "unlock",
      password: "fake",
      executable,
      account: "personal",
      profileDirectory: join(root, "personal"),
    });
    await broker.action("human", {
      type: "unlock",
      password: "fake",
      executable,
      account: "work",
      profileDirectory: join(root, "work"),
    });
    assert.equal((await stat(join(root, "personal"))).isDirectory(), true);
    assert.equal((await stat(join(root, "work"))).mode & 0o777, 0o700);
    assert.equal(broker.state().status, "ready");
    assert.deepEqual(broker.state().accounts, ["personal", "work"]);
    await assert.rejects(
      broker.action("human", {
        type: "unlock",
        password: "fake",
        executable,
        account: "alias",
        profileDirectory: join(root, "work"),
      }),
    );
    assert.deepEqual(broker.state().accounts, ["personal", "work"]);
    await broker.action("human", { type: "lock" });
    assert.equal(broker.state().status, "locked");
    assert.deepEqual(broker.state().accounts, []);
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("account lookups start together and retain account order", async () => {
  const provider = new AccountProvider();
  let finishFirst;
  const first = new Promise((resolve) => {
    finishFirst = resolve;
  });
  let secondStarted = false;
  await provider.add("first", { ...vault("one"), search: () => first });
  await provider.add("second", {
    ...vault("two"),
    search: async () => {
      secondStarted = true;
      return [{ item_id: "same-id", name: "Second", hosts: [] }];
    },
  });
  const search = provider.search("example.com");
  assert.equal(secondStarted, true);
  finishFirst([{ item_id: "same-id", name: "First", hosts: [] }]);
  assert.deepEqual(
    (await search).map((candidate) => candidate.name),
    ["First (first)", "Second (second)"],
  );
  await provider.close();
});
