// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);
const CHECKPOINT_REFS_PREFIX = "refs/t3/orchestration-v2/checkpoints/";

export interface ThreadMovePayloadDescriptor {
  readonly payloadPath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface ThreadMoveWorkspaceDescriptor {
  readonly version: 1;
  readonly headCommit: string;
  readonly stagedCommit: string;
  readonly checkpointRefs: ReadonlyArray<string>;
  readonly gitBundle: ThreadMovePayloadDescriptor;
  readonly gitIndex: ThreadMovePayloadDescriptor;
  readonly workingTree: ThreadMovePayloadDescriptor;
}

export interface ExportThreadWorkspaceInput {
  readonly cwd: string;
  readonly payloadDirectory: string;
  readonly checkpointRefs: ReadonlyArray<string>;
}

export interface RestoreThreadWorkspaceInput {
  readonly importKey?: string;
  readonly repositoryRoot: string;
  readonly targetWorktreePath: string;
  readonly branch: string | null;
  readonly payloadDirectory: string;
  readonly descriptor: ThreadMoveWorkspaceDescriptor;
  readonly replaceCheckpointRefs?: ReadonlyArray<string>;
}

interface OverlayHeader {
  readonly path: string;
  readonly type: "file" | "symlink" | "deleted";
  readonly size: number;
  readonly mode: number;
}

async function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
  options?: { readonly allowFailure?: boolean; readonly env?: NodeJS.ProcessEnv },
): Promise<{ readonly stdout: string; readonly exitCode: number }> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
      ...(options?.env === undefined ? {} : { env: options.env }),
    });
    return { stdout: result.stdout, exitCode: 0 };
  } catch (error) {
    const failure = error as Error & { readonly code?: number; readonly stderr?: string };
    if (options?.allowFailure === true && typeof failure.code === "number") {
      return { stdout: "", exitCode: failure.code };
    }
    throw new Error(
      `Git command failed: git ${args.join(" ")}${failure.stderr ? `: ${failure.stderr.trim()}` : ""}`,
      { cause: error },
    );
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = NodeFS.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function describePayload(
  payloadDirectory: string,
  payloadPath: string,
): Promise<ThreadMovePayloadDescriptor> {
  const absolutePath = NodePath.join(payloadDirectory, payloadPath);
  const stat = await NodeFSP.stat(absolutePath);
  return {
    payloadPath,
    sizeBytes: Number(stat.size),
    sha256: await sha256File(absolutePath),
  };
}

function portableWorkspacePath(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.split("/").some((segment) => segment === "." || segment === "..") ||
    normalized.toLowerCase() === ".git" ||
    normalized.toLowerCase().startsWith(".git/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.includes("\0") ||
    NodePath.isAbsolute(relativePath)
  ) {
    throw new Error(`Workspace path '${relativePath}' is not portable.`);
  }
  return normalized;
}

async function writeBytes(handle: NodeFSP.FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset);
    offset += result.bytesWritten;
  }
}

async function writeOverlayHeader(
  handle: NodeFSP.FileHandle,
  header: OverlayHeader,
): Promise<void> {
  const encoded = Buffer.from(JSON.stringify(header), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(encoded.byteLength);
  await writeBytes(handle, length);
  await writeBytes(handle, encoded);
}

async function writeWorkingTreeOverlay(cwd: string, outputPath: string): Promise<void> {
  const listed = await runGit(cwd, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  const paths = listed.stdout
    .split("\0")
    .filter((candidate) => candidate.length > 0)
    .map(portableWorkspacePath)
    .toSorted();
  const handle = await NodeFSP.open(outputPath, "wx");
  try {
    for (const relativePath of paths) {
      const absolutePath = NodePath.join(cwd, relativePath);
      let stat: NodeFS.Stats;
      try {
        stat = await NodeFSP.lstat(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          await writeOverlayHeader(handle, {
            path: relativePath,
            type: "deleted",
            size: 0,
            mode: 0,
          });
          continue;
        }
        throw error;
      }
      if (stat.isSymbolicLink()) {
        const target = Buffer.from(await NodeFSP.readlink(absolutePath), "utf8");
        await writeOverlayHeader(handle, {
          path: relativePath,
          type: "symlink",
          size: target.byteLength,
          mode: stat.mode & 0o777,
        });
        await writeBytes(handle, target);
        continue;
      }
      if (!stat.isFile()) continue;
      await writeOverlayHeader(handle, {
        path: relativePath,
        type: "file",
        size: Number(stat.size),
        mode: stat.mode & 0o777,
      });
      for await (const chunk of NodeFS.createReadStream(absolutePath)) {
        await writeBytes(handle, chunk);
      }
    }
  } finally {
    await handle.close();
  }
}

async function validatePayload(
  payloadDirectory: string,
  descriptor: ThreadMovePayloadDescriptor,
): Promise<string> {
  const payloadRoot = `${NodePath.resolve(payloadDirectory)}${NodePath.sep}`;
  const absolutePath = NodePath.resolve(payloadDirectory, descriptor.payloadPath);
  if (!absolutePath.startsWith(payloadRoot)) throw new Error("A move payload escaped its root.");
  const stat = await NodeFSP.stat(absolutePath);
  if (
    Number(stat.size) !== descriptor.sizeBytes ||
    (await sha256File(absolutePath)) !== descriptor.sha256
  ) {
    throw new Error(`Move payload '${descriptor.payloadPath}' failed integrity validation.`);
  }
  return absolutePath;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await NodeFSP.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readExactly(
  handle: NodeFSP.FileHandle,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead === 0) throw new Error("Working-tree overlay ended unexpectedly.");
    offset += result.bytesRead;
  }
  return buffer;
}

async function restoreRegularFile(input: {
  readonly archive: NodeFSP.FileHandle;
  readonly sourcePosition: number;
  readonly size: number;
  readonly destinationPath: string;
  readonly mode: number;
}): Promise<void> {
  const destination = await NodeFSP.open(input.destinationPath, "wx", input.mode);
  const buffer = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, input.size)));
  try {
    let copied = 0;
    while (copied < input.size) {
      const requested = Math.min(buffer.byteLength, input.size - copied);
      const read = await input.archive.read(buffer, 0, requested, input.sourcePosition + copied);
      if (read.bytesRead === 0) throw new Error("Working-tree overlay ended unexpectedly.");
      let written = 0;
      while (written < read.bytesRead) {
        const result = await destination.write(buffer, written, read.bytesRead - written);
        written += result.bytesWritten;
      }
      copied += read.bytesRead;
    }
  } finally {
    await destination.close();
  }
  await NodeFSP.chmod(input.destinationPath, input.mode);
}

async function assertSafeParent(rootPath: string, destinationPath: string): Promise<void> {
  const relative = NodePath.relative(rootPath, NodePath.dirname(destinationPath));
  let current = NodePath.resolve(rootPath);
  for (const segment of relative.split(NodePath.sep).filter((part) => part.length > 0)) {
    current = NodePath.join(current, segment);
    try {
      const stat = await NodeFSP.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Move archive cannot write through symlink parent '${current}'.`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Move archive parent '${current}' is not a directory.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await NodeFSP.mkdir(current);
    }
  }
}

async function restoreWorkingTreeOverlay(worktreePath: string, overlayPath: string): Promise<void> {
  const handle = await NodeFSP.open(overlayPath, "r");
  try {
    const archiveSize = Number((await handle.stat()).size);
    let position = 0;
    while (position < archiveSize) {
      const headerLength = (await readExactly(handle, 4, position)).readUInt32BE();
      position += 4;
      if (headerLength === 0 || headerLength > 1024 * 1024) {
        throw new Error("Working-tree overlay contains an invalid header.");
      }
      const header = JSON.parse(
        (await readExactly(handle, headerLength, position)).toString("utf8"),
      ) as OverlayHeader;
      position += headerLength;
      const relativePath = portableWorkspacePath(header.path);
      if (
        !Number.isSafeInteger(header.size) ||
        header.size < 0 ||
        position + header.size > archiveSize
      ) {
        throw new Error("Working-tree overlay contains an invalid entry size.");
      }
      const destinationPath = NodePath.resolve(worktreePath, relativePath);
      const worktreeRoot = `${NodePath.resolve(worktreePath)}${NodePath.sep}`;
      if (!destinationPath.startsWith(worktreeRoot)) {
        throw new Error("Working-tree overlay escaped its destination.");
      }
      if (header.type === "deleted") {
        await assertSafeParent(worktreePath, destinationPath);
        await NodeFSP.rm(destinationPath, { recursive: true, force: true });
      } else {
        await assertSafeParent(worktreePath, destinationPath);
        await NodeFSP.rm(destinationPath, { recursive: true, force: true });
        if (header.type === "symlink") {
          if (header.size > 16 * 1024) {
            throw new Error("Working-tree overlay contains an invalid symlink target.");
          }
          const bytes = await readExactly(handle, header.size, position);
          await NodeFSP.symlink(bytes.toString("utf8"), destinationPath);
        } else if (header.type === "file") {
          await restoreRegularFile({
            archive: handle,
            sourcePosition: position,
            size: header.size,
            destinationPath,
            mode: header.mode,
          });
        } else {
          throw new Error("Working-tree overlay contains an unknown entry type.");
        }
      }
      position += header.size;
    }
  } finally {
    await handle.close();
  }
}

export async function exportThreadWorkspace(
  input: ExportThreadWorkspaceInput,
): Promise<ThreadMoveWorkspaceDescriptor> {
  await NodeFSP.mkdir(input.payloadDirectory, { recursive: true });
  const headCommit = (await runGit(input.cwd, ["rev-parse", "HEAD"])).stdout.trim();
  const checkpointRefs = [...new Set(input.checkpointRefs)].toSorted();
  for (const checkpointRef of checkpointRefs) {
    if (!checkpointRef.startsWith(CHECKPOINT_REFS_PREFIX)) {
      throw new Error(`Checkpoint ref '${checkpointRef}' is outside the portable namespace.`);
    }
    const exists = await runGit(input.cwd, ["show-ref", "--verify", "--quiet", checkpointRef], {
      allowFailure: true,
    });
    if (exists.exitCode !== 0) throw new Error(`Checkpoint ref does not exist: ${checkpointRef}`);
  }
  const sharedIndexPath = (
    await runGit(input.cwd, ["rev-parse", "--shared-index-path"], { allowFailure: true })
  ).stdout.trim();
  if (sharedIndexPath.length > 0) {
    throw new Error("Thread moves do not support split Git indexes.");
  }
  const stagedEntries = (await runGit(input.cwd, ["ls-files", "--stage"])).stdout;
  if (/^160000 /m.test(stagedEntries))
    throw new Error("Thread moves do not support Git submodules.");
  if (
    (
      await runGit(input.cwd, ["config", "--bool", "core.sparseCheckout"], { allowFailure: true })
    ).stdout.trim() === "true"
  )
    throw new Error("Thread moves do not support sparse checkouts.");
  if (/^\d+ 0{40} 0\t/m.test(stagedEntries)) {
    throw new Error("Thread moves do not support intent-to-add index entries.");
  }
  const bundlePath = "git.bundle";
  const bundleAbsolutePath = NodePath.join(input.payloadDirectory, bundlePath);
  const stagedTree = (await runGit(input.cwd, ["write-tree"])).stdout.trim();
  const stagedCommit = (
    await runGit(
      input.cwd,
      ["commit-tree", stagedTree, "-p", headCommit, "-m", "T3 thread move staged state"],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "T3 Code",
          GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
          GIT_COMMITTER_NAME: "T3 Code",
          GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
        },
      },
    )
  ).stdout.trim();
  const stagedCommitRef = `refs/t3/thread-moves/export-${NodeCrypto.randomUUID()}`;
  await runGit(input.cwd, ["update-ref", stagedCommitRef, stagedCommit]);
  try {
    await runGit(input.cwd, [
      "bundle",
      "create",
      bundleAbsolutePath,
      "HEAD",
      stagedCommitRef,
      ...checkpointRefs,
    ]);
  } finally {
    await runGit(input.cwd, ["update-ref", "-d", stagedCommitRef], { allowFailure: true });
  }

  const indexPath = "git.index";
  const sourceIndexPath = (
    await runGit(input.cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"])
  ).stdout.trim();
  await NodeFSP.copyFile(
    sourceIndexPath,
    NodePath.join(input.payloadDirectory, indexPath),
    NodeFS.constants.COPYFILE_EXCL,
  );

  const workingTreePath = "working-tree.bin";
  await writeWorkingTreeOverlay(input.cwd, NodePath.join(input.payloadDirectory, workingTreePath));
  return {
    version: 1,
    headCommit,
    stagedCommit,
    checkpointRefs,
    gitBundle: await describePayload(input.payloadDirectory, bundlePath),
    gitIndex: await describePayload(input.payloadDirectory, indexPath),
    workingTree: await describePayload(input.payloadDirectory, workingTreePath),
  };
}

export async function fingerprintThreadWorkspace(
  cwd: string,
  temporaryDirectory: string,
): Promise<string> {
  await NodeFSP.mkdir(temporaryDirectory, { recursive: true });
  const overlay = NodePath.join(temporaryDirectory, "fingerprint.bin");
  const head = (await runGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();
  const index = (await runGit(cwd, ["write-tree"])).stdout.trim();
  await writeWorkingTreeOverlay(cwd, overlay);
  return NodeCrypto.createHash("sha256")
    .update(`${head}\n${index}\n${await sha256File(overlay)}`)
    .digest("hex");
}

export async function restoreThreadWorkspace(input: RestoreThreadWorkspaceInput): Promise<{
  readonly headCommit: string;
  readonly worktreePath: string;
  readonly rollback: () => Promise<void>;
}> {
  if (input.descriptor.version !== 1) throw new Error("Unsupported workspace archive version.");
  const [bundlePath, indexPath, overlayPath] = await Promise.all([
    validatePayload(input.payloadDirectory, input.descriptor.gitBundle),
    validatePayload(input.payloadDirectory, input.descriptor.gitIndex),
    validatePayload(input.payloadDirectory, input.descriptor.workingTree),
  ]);
  if (await pathExists(input.targetWorktreePath)) {
    throw new Error(`The destination worktree path already exists: ${input.targetWorktreePath}`);
  }
  if (input.branch !== null) {
    const branchExists = await runGit(
      input.repositoryRoot,
      ["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`],
      { allowFailure: true },
    );
    if (branchExists.exitCode === 0)
      throw new Error(`The destination branch already exists: ${input.branch}`);
  }
  for (const checkpointRef of input.descriptor.checkpointRefs) {
    if (!checkpointRef.startsWith(CHECKPOINT_REFS_PREFIX)) {
      throw new Error(`Checkpoint ref '${checkpointRef}' is outside the portable namespace.`);
    }
    const exists = await runGit(
      input.repositoryRoot,
      ["show-ref", "--verify", "--quiet", checkpointRef],
      {
        allowFailure: true,
      },
    );
    if (exists.exitCode === 0 && !input.replaceCheckpointRefs?.includes(checkpointRef))
      throw new Error(`Checkpoint ref already exists: ${checkpointRef}`);
  }

  const importKey = input.importKey ?? NodeCrypto.randomUUID();
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(importKey)) throw new Error("Invalid move import key.");
  const importRef = `refs/t3/thread-moves/import-${importKey}`;
  const stagedImportRef = `refs/t3/thread-moves/staged-${importKey}`;
  const checkpointImportRefs = input.descriptor.checkpointRefs.map(
    (_, index) => `refs/t3/thread-moves/checkpoint-${importKey}-${index}`,
  );
  const checkpointBackupRefs = input.descriptor.checkpointRefs.map(
    (_, index) => `refs/t3/thread-moves/replaced-checkpoint-${importKey}-${index}`,
  );
  const advertised = new Map(
    (await runGit(input.repositoryRoot, ["bundle", "list-heads", bundlePath])).stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const separator = line.indexOf(" ");
        return [line.slice(separator + 1), line.slice(0, separator)] as const;
      }),
  );
  if (advertised.get("HEAD") !== input.descriptor.headCommit) {
    throw new Error("The Git bundle HEAD does not match the workspace descriptor.");
  }
  if (![...advertised.values()].includes(input.descriptor.stagedCommit)) {
    throw new Error("The Git bundle does not contain the staged tree commit.");
  }
  for (const checkpointRef of input.descriptor.checkpointRefs) {
    if (!advertised.has(checkpointRef)) {
      throw new Error(`The Git bundle does not contain checkpoint ref '${checkpointRef}'.`);
    }
  }
  let worktreeCreated = false;
  let branchCreated = false;
  const installedCheckpointRefs: Array<{
    readonly name: string;
    readonly previousCommit: string | null;
    readonly backupRef: string | null;
  }> = [];
  try {
    await runGit(input.repositoryRoot, ["fetch", bundlePath, `HEAD:${importRef}`]);
    await runGit(input.repositoryRoot, [
      "fetch",
      bundlePath,
      `${input.descriptor.stagedCommit}:${stagedImportRef}`,
    ]);
    for (const [index, checkpointRef] of input.descriptor.checkpointRefs.entries()) {
      const temporaryRef = checkpointImportRefs[index]!;
      await runGit(input.repositoryRoot, ["fetch", bundlePath, `${checkpointRef}:${temporaryRef}`]);
      const checkpointCommit = (
        await runGit(input.repositoryRoot, ["rev-parse", temporaryRef])
      ).stdout.trim();
      const previous = await runGit(input.repositoryRoot, ["rev-parse", checkpointRef], {
        allowFailure: true,
      });
      const previousCommit = previous.exitCode === 0 ? previous.stdout.trim() : null;
      const backupRef = previousCommit === null ? null : checkpointBackupRefs[index]!;
      if (backupRef !== null)
        await runGit(input.repositoryRoot, ["update-ref", backupRef, previousCommit!]);
      await runGit(input.repositoryRoot, [
        "update-ref",
        checkpointRef,
        checkpointCommit,
        previousCommit ?? "0000000000000000000000000000000000000000",
      ]);
      installedCheckpointRefs.push({ name: checkpointRef, previousCommit, backupRef });
    }
    await runGit(
      input.repositoryRoot,
      input.branch === null
        ? ["worktree", "add", "--detach", input.targetWorktreePath, importRef]
        : ["worktree", "add", "-b", input.branch, input.targetWorktreePath, importRef],
    );
    worktreeCreated = true;
    branchCreated = input.branch !== null;
    const destinationIndexPath = (
      await runGit(input.targetWorktreePath, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "index",
      ])
    ).stdout.trim();
    await NodeFSP.copyFile(indexPath, destinationIndexPath);
    await restoreWorkingTreeOverlay(input.targetWorktreePath, overlayPath);
    const restoredHead = (
      await runGit(input.targetWorktreePath, ["rev-parse", "HEAD"])
    ).stdout.trim();
    if (restoredHead !== input.descriptor.headCommit) {
      throw new Error("The restored worktree HEAD does not match the exported commit.");
    }
    return {
      headCommit: restoredHead,
      worktreePath: input.targetWorktreePath,
      rollback: async () => {
        await runGit(
          input.repositoryRoot,
          ["worktree", "remove", "--force", input.targetWorktreePath],
          { allowFailure: true },
        );
        if (branchCreated && input.branch !== null) {
          await runGit(input.repositoryRoot, ["branch", "-D", input.branch], {
            allowFailure: true,
          });
        }
        for (const checkpointRef of installedCheckpointRefs) {
          await runGit(
            input.repositoryRoot,
            checkpointRef.previousCommit === null
              ? ["update-ref", "-d", checkpointRef.name]
              : ["update-ref", checkpointRef.name, checkpointRef.previousCommit],
            { allowFailure: true },
          );
          if (checkpointRef.backupRef !== null)
            await runGit(input.repositoryRoot, ["update-ref", "-d", checkpointRef.backupRef], {
              allowFailure: true,
            });
        }
      },
    };
  } catch (error) {
    if (worktreeCreated) {
      await runGit(
        input.repositoryRoot,
        ["worktree", "remove", "--force", input.targetWorktreePath],
        { allowFailure: true },
      );
    }
    if (branchCreated && input.branch !== null) {
      await runGit(input.repositoryRoot, ["branch", "-D", input.branch], {
        allowFailure: true,
      });
    }
    for (const checkpointRef of installedCheckpointRefs) {
      await runGit(
        input.repositoryRoot,
        checkpointRef.previousCommit === null
          ? ["update-ref", "-d", checkpointRef.name]
          : ["update-ref", checkpointRef.name, checkpointRef.previousCommit],
        { allowFailure: true },
      );
      if (checkpointRef.backupRef !== null)
        await runGit(input.repositoryRoot, ["update-ref", "-d", checkpointRef.backupRef], {
          allowFailure: true,
        });
    }
    throw error;
  } finally {
    await runGit(input.repositoryRoot, ["update-ref", "-d", stagedImportRef], {
      allowFailure: true,
    });
    await runGit(input.repositoryRoot, ["update-ref", "-d", importRef], { allowFailure: true });
    for (const temporaryRef of checkpointImportRefs) {
      await runGit(input.repositoryRoot, ["update-ref", "-d", temporaryRef], {
        allowFailure: true,
      });
    }
  }
}
