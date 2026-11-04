import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileRegistry } from "../src/profiles.js";

test("discovers custom config profiles and remembers only names and canonical paths across restarts", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "bw-profiles-")));
  try {
    const directory = join(home, ".config", "lse");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "data.json"), "must not read vault contents");
    const file = join(home, "state", "profiles.json");
    const registry = new ProfileRegistry({ file, home, env: {}, platform: "darwin" });
    assert.deepEqual(await registry.list(), [{ name: "lse", directory, saved: false }]);
    assert.equal(registry.expand("~/.config/lse"), directory);
    await registry.remember("Secondary", directory);
    const restarted = new ProfileRegistry({ file, home, env: {}, platform: "darwin" });
    assert.deepEqual(await restarted.list(), [{ name: "Secondary", directory, saved: true }]);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), [{ name: "Secondary", directory }]);
    await restarted.forget(directory);
    assert.equal((await restarted.list())[0].saved, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("retains saved paths outside discovery roots even when unavailable", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "bw-profiles-")));
  try {
    const registry = new ProfileRegistry({ file: join(home, "profiles.json"), home, env: {} });
    await registry.remember("Remote mount", join(home, "unmounted", "profile"));
    assert.equal((await registry.list())[0].name, "Remote mount");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
