// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

import { afterEach, assert, describe, expect, it } from "vite-plus/test";

import {
  exportThreadWorkspace,
  restoreThreadWorkspace,
  readThreadMoveRepositoryHead,
} from "./ThreadMovePortable.ts";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);
const tempDirectories: Array<string> = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

async function git(cwd: string, ...args: ReadonlyArray<string>): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("ThreadMovePortable", () => {
  it("round-trips HEAD, checkpoint refs, index state, worktree state, modes, and symlinks", async () => {
    const source = await temporaryDirectory("t3-move-source-");
    const destinationRepository = await temporaryDirectory("t3-move-destination-repo-");
    const destinationWorktree = NodePath.join(
      await temporaryDirectory("t3-move-destination-parent-"),
      "worktree",
    );
    const payloadDirectory = await temporaryDirectory("t3-move-payload-");
    await git(source, "init", "-b", "main");
    await git(source, "config", "user.email", "test@example.com");
    await git(source, "config", "user.name", "Test");
    await NodeFSP.writeFile(NodePath.join(source, "staged.txt"), "base\n");
    await NodeFSP.writeFile(NodePath.join(source, "deleted.txt"), "delete me\n");
    await git(source, "add", ".");
    await git(source, "commit", "-m", "base");
    await git(source, "update-ref", "refs/t3/orchestration-v2/checkpoints/test/ordinal/0", "HEAD");

    await NodeFSP.writeFile(NodePath.join(source, "staged.txt"), "staged\n");
    await git(source, "add", "staged.txt");
    await NodeFSP.writeFile(NodePath.join(source, "staged.txt"), "unstaged after stage\n");
    await NodeFSP.rm(NodePath.join(source, "deleted.txt"));
    await NodeFSP.writeFile(NodePath.join(source, "executable.sh"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    await NodeFSP.symlink("staged.txt", NodePath.join(source, "linked.txt"));
    await NodeFSP.writeFile(NodePath.join(source, "ignored.log"), "ignored");
    await NodeFSP.writeFile(NodePath.join(source, ".gitignore"), "*.log\n");

    const checkpointRef = "refs/t3/orchestration-v2/checkpoints/test/ordinal/0";
    const exported = await exportThreadWorkspace({
      cwd: source,
      payloadDirectory,
      checkpointRefs: [checkpointRef],
    });
    await git(destinationRepository, "init", "-b", "destination-root");
    const restored = await restoreThreadWorkspace({
      repositoryRoot: destinationRepository,
      targetWorktreePath: destinationWorktree,
      branch: "moved-thread",
      payloadDirectory,
      descriptor: exported,
    });

    assert.equal(restored.headCommit, await git(source, "rev-parse", "HEAD"));
    assert.equal(
      await NodeFSP.readFile(NodePath.join(destinationWorktree, "staged.txt"), "utf8"),
      "unstaged after stage\n",
    );
    assert.equal(await git(destinationWorktree, "show", ":staged.txt"), "staged");
    assert.match(await git(destinationWorktree, "status", "--short"), /MM staged\.txt/);
    await expect(
      NodeFSP.access(NodePath.join(destinationWorktree, "deleted.txt")),
    ).rejects.toThrow();
    await expect(
      NodeFSP.access(NodePath.join(destinationWorktree, "ignored.log")),
    ).rejects.toThrow();
    assert.equal(
      await NodeFSP.readlink(NodePath.join(destinationWorktree, "linked.txt")),
      "staged.txt",
    );
    assert.equal(
      (await NodeFSP.stat(NodePath.join(destinationWorktree, "executable.sh"))).mode & 0o111,
      0o111,
    );
    assert.equal(
      await git(
        destinationRepository,
        "rev-parse",
        "refs/t3/orchestration-v2/checkpoints/test/ordinal/0",
      ),
      await git(source, "rev-parse", "HEAD"),
    );
    await restored.rollback();
    await expect(NodeFSP.access(destinationWorktree)).rejects.toThrow();
    await expect(
      git(destinationRepository, "show-ref", "--verify", checkpointRef),
    ).rejects.toThrow();
  });

  it("rejects corrupt payloads and branch/worktree collisions without overwrite", async () => {
    const source = await temporaryDirectory("t3-move-collision-source-");
    const payloadDirectory = await temporaryDirectory("t3-move-collision-payload-");
    const destinationRepository = await temporaryDirectory("t3-move-collision-repo-");
    const destinationParent = await temporaryDirectory("t3-move-collision-parent-");
    const destinationWorktree = NodePath.join(destinationParent, "worktree");
    await git(source, "init", "-b", "main");
    await git(source, "config", "user.email", "test@example.com");
    await git(source, "config", "user.name", "Test");
    await NodeFSP.writeFile(NodePath.join(source, "file.txt"), "base\n");
    await git(source, "add", ".");
    await git(source, "commit", "-m", "base");
    const exported = await exportThreadWorkspace({
      cwd: source,
      payloadDirectory,
      checkpointRefs: [],
    });
    await git(destinationRepository, "init", "-b", "destination-root");
    const overlayPath = NodePath.join(payloadDirectory, exported.workingTree.payloadPath);
    const originalOverlay = await NodeFSP.readFile(overlayPath);
    await NodeFSP.appendFile(overlayPath, "tampered");

    await expect(
      restoreThreadWorkspace({
        repositoryRoot: destinationRepository,
        targetWorktreePath: destinationWorktree,
        branch: "moved-thread",
        payloadDirectory,
        descriptor: exported,
      }),
    ).rejects.toThrow(/integrity/);
    await expect(NodeFSP.access(destinationWorktree)).rejects.toThrow();

    await NodeFSP.writeFile(overlayPath, originalOverlay);
    await NodeFSP.mkdir(destinationWorktree);
    await expect(
      restoreThreadWorkspace({
        repositoryRoot: destinationRepository,
        targetWorktreePath: destinationWorktree,
        branch: "moved-thread",
        payloadDirectory,
        descriptor: exported,
      }),
    ).rejects.toThrow(/worktree path already exists/);
  });

  it("exports only requested checkpoint refs", async () => {
    const source = await temporaryDirectory("t3-move-scoped-source-");
    const payloadDirectory = await temporaryDirectory("t3-move-scoped-payload-");
    await git(source, "init", "-b", "main");
    await NodeFSP.writeFile(NodePath.join(source, "file.txt"), "base\n");
    await git(source, "add", ".");
    await git(
      source,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "base",
    );
    const owned = "refs/t3/orchestration-v2/checkpoints/owned/ordinal/0";
    const unrelated = "refs/t3/orchestration-v2/checkpoints/unrelated/ordinal/0";
    await git(source, "update-ref", owned, "HEAD");
    await git(source, "update-ref", unrelated, "HEAD");

    const exported = await exportThreadWorkspace({
      cwd: source,
      payloadDirectory,
      checkpointRefs: [owned],
    });
    const heads = await git(
      source,
      "bundle",
      "list-heads",
      NodePath.join(payloadDirectory, exported.gitBundle.payloadPath),
    );
    assert.include(heads, owned);
    assert.notInclude(heads, unrelated);
  });

  it("backs up and restores an owned checkpoint ref during replacement", async () => {
    const source = await temporaryDirectory("t3-move-checkpoint-source-");
    const payloadDirectory = await temporaryDirectory("t3-move-checkpoint-payload-");
    const destinationRepository = await temporaryDirectory("t3-move-checkpoint-repo-");
    const destinationWorktree = NodePath.join(
      await temporaryDirectory("t3-move-checkpoint-parent-"),
      "worktree",
    );
    const checkpointRef = "refs/t3/orchestration-v2/checkpoints/shared/ordinal/0";
    await git(source, "init", "-b", "main");
    await NodeFSP.writeFile(NodePath.join(source, "file.txt"), "incoming\n");
    await git(source, "add", ".");
    await git(
      source,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "incoming",
    );
    await git(source, "update-ref", checkpointRef, "HEAD");
    const incomingCommit = await git(source, "rev-parse", "HEAD");
    const exported = await exportThreadWorkspace({
      cwd: source,
      payloadDirectory,
      checkpointRefs: [checkpointRef],
    });
    await git(destinationRepository, "init", "-b", "destination-root");
    await NodeFSP.writeFile(NodePath.join(destinationRepository, "prior.txt"), "prior\n");
    await git(destinationRepository, "add", ".");
    await git(
      destinationRepository,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "prior",
    );
    const previousCommit = await git(destinationRepository, "rev-parse", "HEAD");
    await git(destinationRepository, "update-ref", checkpointRef, previousCommit);

    const restored = await restoreThreadWorkspace({
      importKey: "checkpoint-replacement",
      repositoryRoot: destinationRepository,
      targetWorktreePath: destinationWorktree,
      branch: "moved-checkpoint-replacement",
      payloadDirectory,
      descriptor: exported,
      replaceCheckpointRefs: [checkpointRef],
    });
    assert.equal(await git(destinationRepository, "rev-parse", checkpointRef), incomingCommit);
    assert.equal(
      await git(
        destinationRepository,
        "rev-parse",
        "refs/t3/thread-moves/replaced-checkpoint-checkpoint-replacement-0",
      ),
      previousCommit,
    );
    await restored.rollback();
    assert.equal(await git(destinationRepository, "rev-parse", checkpointRef), previousCommit);
    await expect(
      git(
        destinationRepository,
        "show-ref",
        "--verify",
        "refs/t3/thread-moves/replaced-checkpoint-checkpoint-replacement-0",
      ),
    ).rejects.toThrow();
  });

  it.each(["invalid-header", "./.git", ".GIT"])(
    "rolls back worktree, branch, and refs after a validly hashed malformed overlay: %s",
    async (malformation) => {
      const source = await temporaryDirectory("t3-move-rollback-source-");
      const payloadDirectory = await temporaryDirectory("t3-move-rollback-payload-");
      const destinationRepository = await temporaryDirectory("t3-move-rollback-repo-");
      const destinationWorktree = NodePath.join(
        await temporaryDirectory("t3-move-rollback-parent-"),
        "worktree",
      );
      await git(source, "init", "-b", "main");
      await NodeFSP.writeFile(NodePath.join(source, "file.txt"), "base\n");
      await git(source, "add", ".");
      await git(
        source,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "base",
      );
      const checkpointRef = "refs/t3/orchestration-v2/checkpoints/rollback/ordinal/0";
      await git(source, "update-ref", checkpointRef, "HEAD");
      const exported = await exportThreadWorkspace({
        cwd: source,
        payloadDirectory,
        checkpointRefs: [checkpointRef],
      });
      const overlayPath = NodePath.join(payloadDirectory, exported.workingTree.payloadPath);
      const header = Buffer.from(
        JSON.stringify({ path: malformation, type: "file", size: 4, mode: 0o600 }),
      );
      const length = Buffer.alloc(4);
      length.writeUInt32BE(malformation === "invalid-header" ? 2 * 1024 * 1024 : header.length);
      const malformed =
        malformation === "invalid-header"
          ? length
          : Buffer.concat([length, header, Buffer.from("evil")]);
      await NodeFSP.writeFile(overlayPath, malformed);
      const descriptor = {
        ...exported,
        workingTree: {
          ...exported.workingTree,
          sizeBytes: malformed.byteLength,
          sha256: NodeCrypto.createHash("sha256").update(malformed).digest("hex"),
        },
      };
      await git(destinationRepository, "init", "-b", "destination-root");

      await expect(
        restoreThreadWorkspace({
          repositoryRoot: destinationRepository,
          targetWorktreePath: destinationWorktree,
          branch: "moved-thread",
          payloadDirectory,
          descriptor,
        }),
      ).rejects.toThrow(/invalid header|not portable/);
      await expect(NodeFSP.access(destinationWorktree)).rejects.toThrow();
      assert.equal(
        await git(
          destinationRepository,
          "show-ref",
          "--verify",
          "--quiet",
          "refs/heads/moved-thread",
        ).catch(() => "missing"),
        "missing",
      );
      assert.equal(
        await git(destinationRepository, "show-ref", "--verify", "--quiet", checkpointRef).catch(
          () => "missing",
        ),
        "missing",
      );
    },
  );
});

it("transfers a small delta against a clean destination without copying dependencies or shared Git history", async () => {
  const source = await temporaryDirectory("t3-move-delta-source-");
  const destination = NodePath.join(await temporaryDirectory("t3-move-delta-destination-"), "repo");
  const payload = await temporaryDirectory("t3-move-delta-payload-");
  const target = NodePath.join(await temporaryDirectory("t3-move-delta-worktree-"), "worktree");
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.email", "test@example.com");
  await git(source, "config", "user.name", "Test");
  const baseline = NodeCrypto.randomBytes(4 * 1024 * 1024);
  await NodeFSP.writeFile(NodePath.join(source, "unchanged.bin"), baseline);
  await NodeFSP.writeFile(NodePath.join(source, "changed.txt"), "base\n");
  await NodeFSP.writeFile(NodePath.join(source, "deleted.txt"), "base\n");
  await NodeFSP.writeFile(NodePath.join(source, "assumed.txt"), "base\n");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "initial");
  await NodeFSP.writeFile(NodePath.join(source, "second.txt"), "second\n");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "shared base");
  const base = await git(source, "rev-parse", "HEAD");
  const shallowDestination = NodePath.join(await temporaryDirectory("t3-move-shallow-"), "repo");
  await git(source, "clone", "--depth", "1", `file://${source}`, shallowDestination);
  expect(await readThreadMoveRepositoryHead(shallowDestination)).toBeUndefined();
  expect(await readThreadMoveRepositoryHead(source)).toBe(base);
  const checkpoint = "refs/t3/orchestration-v2/checkpoints/delta/ordinal/0";
  await git(source, "update-ref", checkpoint, "HEAD");
  await git(source, "clone", source, destination);
  await NodeFSP.writeFile(NodePath.join(source, "committed.txt"), "unpublished commit\n");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "local commit");
  await NodeFSP.writeFile(NodePath.join(source, "changed.txt"), "staged\n");
  await git(source, "add", "changed.txt");
  await NodeFSP.writeFile(NodePath.join(source, "changed.txt"), "unstaged\n");
  await NodeFSP.rm(NodePath.join(source, "deleted.txt"));
  await git(source, "update-index", "--assume-unchanged", "assumed.txt");
  await NodeFSP.writeFile(NodePath.join(source, "assumed.txt"), "hidden change\n");
  await NodeFSP.mkdir(NodePath.join(source, "node_modules"));
  await NodeFSP.writeFile(NodePath.join(source, "node_modules", "dependency.bin"), baseline);
  await NodeFSP.writeFile(NodePath.join(source, "untracked.txt"), "new file\n");
  await git(source, "config", "core.fileMode", "false");
  await NodeFSP.chmod(NodePath.join(source, "second.txt"), 0o755);
  await NodeFSP.chmod(NodePath.join(source, "committed.txt"), 0o600);
  const descriptor = await exportThreadWorkspace({
    cwd: source,
    payloadDirectory: payload,
    checkpointRefs: [checkpoint],
    destinationHeadCommit: base,
  });
  expect(descriptor.workingTree.sizeBytes).toBeLessThan(2048);
  expect(descriptor.gitBundle.sizeBytes).toBeLessThan(16 * 1024);
  await restoreThreadWorkspace({
    repositoryRoot: destination,
    targetWorktreePath: target,
    branch: "moved",
    payloadDirectory: payload,
    descriptor,
  });
  expect(await NodeFSP.readFile(NodePath.join(target, "unchanged.bin"))).toEqual(baseline);
  expect(await NodeFSP.readFile(NodePath.join(target, "changed.txt"), "utf8")).toBe("unstaged\n");
  expect(await git(target, "show", ":changed.txt")).toBe("staged");
  expect(await git(target, "rev-parse", checkpoint)).toBe(base);
  expect((await NodeFSP.stat(NodePath.join(target, "second.txt"))).mode & 0o777).toBe(0o755);
  expect((await NodeFSP.stat(NodePath.join(target, "committed.txt"))).mode & 0o777).toBe(0o600);
  expect(await NodeFSP.readFile(NodePath.join(target, "committed.txt"), "utf8")).toBe(
    "unpublished commit\n",
  );
  expect(await NodeFSP.readFile(NodePath.join(target, "assumed.txt"), "utf8")).toBe(
    "hidden change\n",
  );
  await expect(NodeFSP.access(NodePath.join(target, "node_modules"))).rejects.toThrow();
  await expect(NodeFSP.access(NodePath.join(target, "deleted.txt"))).rejects.toThrow();
  const fallbackPayload = await temporaryDirectory("t3-move-delta-fallback-");
  const fallbackRepository = await temporaryDirectory("t3-move-delta-empty-");
  const fallbackTarget = NodePath.join(
    await temporaryDirectory("t3-move-delta-fallback-worktree-"),
    "worktree",
  );
  await git(fallbackRepository, "init", "-b", "main");
  const fallback = await exportThreadWorkspace({
    cwd: source,
    payloadDirectory: fallbackPayload,
    checkpointRefs: [checkpoint],
    destinationHeadCommit: "0".repeat(40),
  });
  await restoreThreadWorkspace({
    repositoryRoot: fallbackRepository,
    targetWorktreePath: fallbackTarget,
    branch: "moved",
    payloadDirectory: fallbackPayload,
    descriptor: fallback,
  });
  expect(await NodeFSP.readFile(NodePath.join(fallbackTarget, "unchanged.bin"))).toEqual(baseline);
  expect(await git(fallbackTarget, "rev-parse", "HEAD")).toBe(
    await git(source, "rev-parse", "HEAD"),
  );
});
