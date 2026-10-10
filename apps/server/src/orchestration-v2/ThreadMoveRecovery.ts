// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import { hashMoveFile, writeMoveJson } from "./ThreadMoveArchive.ts";
import {
  fingerprintThreadWorkspace,
  type RestoreThreadWorkspaceInput,
} from "./ThreadMovePortable.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const Journal = Schema.Struct({
  repositoryRoot: Schema.String,
  worktreePath: Schema.String,
  branch: Schema.NullOr(Schema.String),
  headCommit: Schema.String,
  refs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      commit: Schema.String,
      previousCommit: Schema.optional(Schema.String),
      backupRef: Schema.optional(Schema.String),
    }),
  ),
  temporaryRefs: Schema.Array(Schema.String),
  workspaceFingerprint: Schema.optional(Schema.String),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      sha256: Schema.String,
      previousPath: Schema.optional(Schema.String),
      previousSha256: Schema.optional(Schema.String),
    }),
  ),
});
export type ThreadMoveJournal = typeof Journal.Type;
const encodeJournal = Schema.encodeSync(Journal);
const decodeJournal = Schema.decodeUnknownSync(Journal);
async function git(cwd: string, ...args: string[]) {
  return (await exec("git", args, { cwd, encoding: "utf8", timeout: 30_000 })).stdout.trim();
}
async function exists(filePath: string) {
  return await NodeFSP.lstat(filePath).then(
    () => true,
    (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    },
  );
}
async function refCommit(cwd: string, ref: string) {
  return await git(cwd, "show-ref", "--hash", "--verify", ref).catch(() => null);
}
/** Records generated destination names before any workspace mutation. */
export async function planMoveWorkspaceRecovery(
  input: RestoreThreadWorkspaceInput & {
    readonly importKey: string;
    readonly workspaceFingerprint?: string;
  },
): Promise<ThreadMoveJournal> {
  if (await exists(input.targetWorktreePath))
    throw new Error("The destination worktree already exists.");
  if (input.branch && (await refCommit(input.repositoryRoot, `refs/heads/${input.branch}`)))
    throw new Error("The destination branch already exists.");
  const advertised = new Map(
    (
      await git(
        input.repositoryRoot,
        "bundle",
        "list-heads",
        NodePath.join(input.payloadDirectory, input.descriptor.gitBundle.payloadPath),
      )
    )
      .split("\n")
      .map((line) => {
        const split = line.indexOf(" ");
        return [line.slice(split + 1), line.slice(0, split)] as const;
      }),
  );
  const refs = [];
  for (const name of input.descriptor.checkpointRefs) {
    if (!name.startsWith("refs/t3/orchestration-v2/checkpoints/"))
      throw new Error("A checkpoint ref is invalid.");
    const previousCommit = await refCommit(input.repositoryRoot, name);
    if (previousCommit && !input.replaceCheckpointRefs?.includes(name))
      throw new Error("A checkpoint ref already exists.");
    const commit = advertised.get(name);
    if (!commit) throw new Error("The checkpoint is absent from the bundle.");
    const index: number = refs.length;
    refs.push({
      name,
      commit,
      ...(previousCommit === null
        ? {}
        : {
            previousCommit,
            backupRef: `refs/t3/thread-moves/replaced-checkpoint-${input.importKey}-${index}`,
          }),
    });
  }
  return {
    repositoryRoot: input.repositoryRoot,
    worktreePath: input.targetWorktreePath,
    branch: input.branch,
    headCommit: input.descriptor.headCommit,
    refs,
    temporaryRefs: [
      `refs/t3/thread-moves/import-${input.importKey}`,
      `refs/t3/thread-moves/staged-${input.importKey}`,
      ...refs.map((_, index) => `refs/t3/thread-moves/checkpoint-${input.importKey}-${index}`),
    ],
    workspaceFingerprint: input.workspaceFingerprint,
    files: [],
  };
}
export async function saveMoveRecoveryJournal(
  filePath: string,
  journal: ThreadMoveJournal,
): Promise<void> {
  await writeMoveJson(filePath, encodeJournal(journal));
}
export async function readMoveRecoveryJournal(filePath: string): Promise<ThreadMoveJournal | null> {
  try {
    return decodeJournal(JSON.parse(await NodeFSP.readFile(filePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
/** Rejects changed artifacts before removing any writes reserved by this import. */
export async function rollbackMoveJournal(journal: ThreadMoveJournal): Promise<void> {
  for (const file of journal.files) {
    if ((await exists(file.path)) && (await hashMoveFile(file.path)) !== file.sha256)
      throw new Error("An imported file changed; recovery needs manual reconciliation.");
    if (
      file.previousPath !== undefined &&
      (!(await exists(file.previousPath)) ||
        (file.previousSha256 !== undefined &&
          (await hashMoveFile(file.previousPath)) !== file.previousSha256))
    )
      throw new Error("A replaced file backup changed; recovery needs manual reconciliation.");
  }
  for (const ref of journal.refs) {
    const current = await refCommit(journal.repositoryRoot, ref.name);
    if (current && current !== ref.commit && current !== ref.previousCommit)
      throw new Error("An imported checkpoint changed; recovery needs manual reconciliation.");
    if (
      ref.backupRef !== undefined &&
      (await refCommit(journal.repositoryRoot, ref.backupRef)) !== ref.previousCommit
    )
      throw new Error(
        "A replaced checkpoint backup changed; recovery needs manual reconciliation.",
      );
  }
  const branchRef = journal.branch ? `refs/heads/${journal.branch}` : null;
  if (branchRef) {
    const current = await refCommit(journal.repositoryRoot, branchRef);
    if (current && current !== journal.headCommit)
      throw new Error("The imported branch changed; recovery needs manual reconciliation.");
  }
  if (await exists(journal.worktreePath)) {
    const listed = await git(journal.repositoryRoot, "worktree", "list", "--porcelain");
    const canonical = await NodeFSP.realpath(journal.worktreePath);
    if (
      !listed.split("\n").includes(`worktree ${canonical}`) &&
      !listed.split("\n").includes(`worktree ${journal.worktreePath}`)
    )
      throw new Error("The staged worktree is not owned by this repository.");
  }
  if (journal.workspaceFingerprint && (await exists(journal.worktreePath))) {
    const temporary = await NodeFSP.mkdtemp(
      NodePath.join(NodePath.dirname(journal.worktreePath), ".move-recovery-"),
    );
    try {
      if (
        (await fingerprintThreadWorkspace(journal.worktreePath, temporary)) !==
        journal.workspaceFingerprint
      )
        throw new Error("The staged worktree changed; recovery needs manual reconciliation.");
    } finally {
      await NodeFSP.rm(temporary, { recursive: true, force: true });
    }
  }
  for (const file of journal.files) {
    await NodeFSP.rm(file.path, { force: true });
    if (file.previousPath !== undefined) {
      await NodeFSP.mkdir(NodePath.dirname(file.path), { recursive: true });
      await NodeFSP.rename(file.previousPath, file.path);
    }
  }
  if (await exists(journal.worktreePath))
    await git(journal.repositoryRoot, "worktree", "remove", "--force", journal.worktreePath);
  if (branchRef && (await refCommit(journal.repositoryRoot, branchRef)))
    await git(journal.repositoryRoot, "update-ref", "-d", branchRef, journal.headCommit);
  for (const ref of journal.refs) {
    const current = await refCommit(journal.repositoryRoot, ref.name);
    if (ref.previousCommit !== undefined && current === ref.commit)
      await git(journal.repositoryRoot, "update-ref", ref.name, ref.previousCommit, ref.commit);
    else if (ref.previousCommit === undefined && current === ref.commit)
      await git(journal.repositoryRoot, "update-ref", "-d", ref.name, ref.commit);
    if (ref.backupRef !== undefined)
      await git(journal.repositoryRoot, "update-ref", "-d", ref.backupRef, ref.previousCommit!);
  }
  for (const ref of journal.temporaryRefs)
    if (await refCommit(journal.repositoryRoot, ref))
      await git(journal.repositoryRoot, "update-ref", "-d", ref);
}
