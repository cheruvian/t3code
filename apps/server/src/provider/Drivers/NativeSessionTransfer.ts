// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export type PortableNativeDriver = "codex" | "claude";

export interface NativeSessionArchiveFile {
  readonly relativePath: string;
  readonly payloadPath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly mode: number;
}

export interface NativeSessionArchive {
  readonly version: 1;
  readonly driver: PortableNativeDriver;
  readonly nativeThreadId: string;
  readonly files: ReadonlyArray<NativeSessionArchiveFile>;
}

export interface ExportNativeSessionInput {
  readonly driver: PortableNativeDriver;
  readonly nativeThreadId: string;
  readonly sourceHomePath: string;
  readonly sourceCwd: string;
  readonly payloadDirectory: string;
  readonly claudeProjectDirectoryName?: string;
}

export interface InstallNativeSessionInput {
  readonly archive: NativeSessionArchive;
  readonly payloadDirectory: string;
  readonly destinationHomePath: string;
  readonly destinationCwd: string;
  readonly claudeProjectDirectoryName?: string;
  /** Existing files are moved here before replacement and retained after success. */
  readonly replacementDirectory?: string;
}

const PRIVATE_ENTRY_NAMES = new Set(["auth.json", "models_cache.json"]);

function validateNativeThreadId(nativeThreadId: string): void {
  if (
    nativeThreadId.length === 0 ||
    nativeThreadId === "." ||
    nativeThreadId === ".." ||
    nativeThreadId.includes("/") ||
    nativeThreadId.includes("\\") ||
    nativeThreadId.includes("\0")
  ) {
    throw new Error("The provider-native session id is not portable.");
  }
}

function portableRelativePath(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  if (
    NodePath.isAbsolute(relativePath) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.includes("\0")
  ) {
    throw new Error(`Native session path '${relativePath}' is not portable.`);
  }
  return normalized;
}

function payloadFileName(index: number): string {
  return `native-${String(index).padStart(4, "0")}.bin`;
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

async function firstJsonRecords(
  filePath: string,
  byteLimit = 1024 * 1024,
): Promise<ReadonlyArray<unknown>> {
  const handle = await NodeFSP.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const buffer = Buffer.alloc(Math.min(Number(stat.size), byteLimit));
    await handle.read(buffer, 0, buffer.length, 0);
    return buffer
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as unknown];
        } catch {
          return [];
        }
      });
  } finally {
    await handle.close();
  }
}

function recordSessionId(record: unknown): string | null {
  if (typeof record !== "object" || record === null) return null;
  const object = record as Record<string, unknown>;
  if (typeof object["sessionId"] === "string") return object["sessionId"];
  const payload = object["payload"];
  if (typeof payload !== "object" || payload === null) return null;
  const payloadRecord = payload as Record<string, unknown>;
  const id = payloadRecord["id"] ?? payloadRecord["session_id"];
  return typeof id === "string" ? id : null;
}

async function fileBelongsToSession(filePath: string, nativeThreadId: string): Promise<boolean> {
  const records = await firstJsonRecords(filePath);
  return records.some((record) => recordSessionId(record) === nativeThreadId);
}

async function walkRegularFiles(directory: string): Promise<ReadonlyArray<string>> {
  let entries: ReadonlyArray<NodeFS.Dirent>;
  try {
    entries = await NodeFSP.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: Array<string> = [];
  for (const entry of entries) {
    if (PRIVATE_ENTRY_NAMES.has(entry.name)) continue;
    const entryPath = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkRegularFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function discoverClaudeFiles(
  input: ExportNativeSessionInput,
): Promise<ReadonlyArray<string>> {
  const projectDirectory = await claudeProjectDirectory(
    input.sourceHomePath,
    input.sourceCwd,
    input.claudeProjectDirectoryName,
  );
  const transcript = NodePath.join(projectDirectory, `${input.nativeThreadId}.jsonl`);
  if (!(await fileBelongsToSession(transcript, input.nativeThreadId).catch(() => false))) {
    throw new Error(`Claude session '${input.nativeThreadId}' was not found for its workspace.`);
  }
  const sessionDirectory = NodePath.join(projectDirectory, input.nativeThreadId);
  const sessionFiles = await walkRegularFiles(sessionDirectory);
  return [transcript, ...sessionFiles.toSorted()];
}

async function discoverCodexFiles(input: ExportNativeSessionInput): Promise<ReadonlyArray<string>> {
  const candidates = [
    ...(await walkRegularFiles(NodePath.join(input.sourceHomePath, "sessions"))),
    ...(await walkRegularFiles(NodePath.join(input.sourceHomePath, "archived_sessions"))),
  ].filter((filePath) => filePath.endsWith(".jsonl"));
  const matchingRollouts: Array<string> = [];
  const namedCandidates = candidates.filter((candidate) =>
    NodePath.basename(candidate).includes(input.nativeThreadId),
  );
  for (const candidate of namedCandidates.length ? namedCandidates : candidates) {
    if (await fileBelongsToSession(candidate, input.nativeThreadId))
      matchingRollouts.push(candidate);
  }
  if (matchingRollouts.length !== 1) {
    throw new Error(
      matchingRollouts.length === 0
        ? `Codex session '${input.nativeThreadId}' was not found.`
        : `Codex session '${input.nativeThreadId}' is ambiguous.`,
    );
  }
  const rollout = matchingRollouts[0]!;
  const siblings = await NodeFSP.readdir(NodePath.dirname(rollout), { withFileTypes: true });
  return [
    rollout,
    ...siblings
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.includes(input.nativeThreadId) &&
          NodePath.join(NodePath.dirname(rollout), entry.name) !== rollout &&
          !PRIVATE_ENTRY_NAMES.has(entry.name),
      )
      .map((entry) => NodePath.join(NodePath.dirname(rollout), entry.name))
      .toSorted(),
  ];
}

export function encodeClaudeProjectPath(cwd: string): string {
  const normalized = NodePath.resolve(cwd).replaceAll("\\", "/");
  const encoded = normalized.replace(/[^a-zA-Z0-9]/g, "-");
  if (encoded.length <= 200) return encoded;
  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(index)) | 0;
  }
  return `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

async function claudeProjectDirectory(
  homePath: string,
  cwd: string,
  override: string | undefined,
): Promise<string> {
  const canonicalCwd = await NodeFSP.realpath(cwd);
  return NodePath.join(homePath, "projects", override ?? encodeClaudeProjectPath(canonicalCwd));
}

export async function exportNativeSession(
  input: ExportNativeSessionInput,
): Promise<NativeSessionArchive> {
  validateNativeThreadId(input.nativeThreadId);
  const sourceFiles =
    input.driver === "claude" ? await discoverClaudeFiles(input) : await discoverCodexFiles(input);
  await NodeFSP.mkdir(input.payloadDirectory, { recursive: true });
  const files: Array<NativeSessionArchiveFile> = [];
  const claudeSourceDirectory =
    input.driver === "claude"
      ? await claudeProjectDirectory(
          input.sourceHomePath,
          input.sourceCwd,
          input.claudeProjectDirectoryName,
        )
      : undefined;
  for (const [index, sourcePath] of sourceFiles.entries()) {
    const relativePath =
      input.driver === "claude"
        ? portableRelativePath(NodePath.relative(claudeSourceDirectory!, sourcePath))
        : portableRelativePath(NodePath.relative(input.sourceHomePath, sourcePath));
    const payloadPath = payloadFileName(index);
    const destinationPath = NodePath.join(input.payloadDirectory, payloadPath);
    await NodeFSP.copyFile(sourcePath, destinationPath, NodeFS.constants.COPYFILE_EXCL);
    const stat = await NodeFSP.stat(sourcePath);
    files.push({
      relativePath,
      payloadPath,
      sizeBytes: Number(stat.size),
      sha256: await sha256File(destinationPath),
      mode: stat.mode & 0o777,
    });
  }
  return {
    version: 1,
    driver: input.driver,
    nativeThreadId: input.nativeThreadId,
    files,
  };
}

async function installRelativePath(
  input: InstallNativeSessionInput,
  file: NativeSessionArchiveFile,
): Promise<string> {
  if (input.archive.driver === "claude") {
    return NodePath.relative(
      input.destinationHomePath,
      NodePath.join(
        await claudeProjectDirectory(
          input.destinationHomePath,
          input.destinationCwd,
          input.claudeProjectDirectoryName,
        ),
        portableRelativePath(file.relativePath),
      ),
    );
  }
  return portableRelativePath(file.relativePath);
}

async function assertSafeParent(rootPath: string, destinationPath: string): Promise<void> {
  const relative = NodePath.relative(rootPath, NodePath.dirname(destinationPath));
  let current = NodePath.resolve(rootPath);
  for (const segment of relative.split(NodePath.sep).filter((part) => part.length > 0)) {
    current = NodePath.join(current, segment);
    try {
      const stat = await NodeFSP.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Native session cannot write through symlink parent '${current}'.`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Native session parent '${current}' is not a directory.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await NodeFSP.mkdir(current);
    }
  }
}

export async function nativeSessionDestinationPaths(
  input: InstallNativeSessionInput,
): Promise<ReadonlyArray<string>> {
  return await Promise.all(
    input.archive.files.map(async (file) =>
      NodePath.resolve(input.destinationHomePath, await installRelativePath(input, file)),
    ),
  );
}

export async function installNativeSession(
  input: InstallNativeSessionInput,
): Promise<() => Promise<void>> {
  validateNativeThreadId(input.archive.nativeThreadId);
  if (input.archive.version !== 1 || input.archive.files.length === 0) {
    throw new Error("The native session archive is invalid.");
  }
  if (
    input.archive.driver === "claude" &&
    (input.archive.files[0]?.relativePath !== `${input.archive.nativeThreadId}.jsonl` ||
      input.archive.files.some(
        (file, index) =>
          index > 0 &&
          !portableRelativePath(file.relativePath).startsWith(`${input.archive.nativeThreadId}/`),
      ))
  ) {
    throw new Error("The Claude native session archive does not match its session id.");
  }
  if (
    input.archive.driver === "codex" &&
    input.archive.files.some((file) => {
      const relativePath = portableRelativePath(file.relativePath);
      return !(
        relativePath.startsWith("sessions/") || relativePath.startsWith("archived_sessions/")
      );
    })
  ) {
    throw new Error("The Codex native session archive contains a path outside session storage.");
  }
  const prepared = await Promise.all(
    input.archive.files.map(async (file) => {
      const payloadPath = NodePath.resolve(
        input.payloadDirectory,
        portableRelativePath(file.payloadPath),
      );
      const payloadRoot = `${NodePath.resolve(input.payloadDirectory)}${NodePath.sep}`;
      if (!payloadPath.startsWith(payloadRoot))
        throw new Error("The native payload path escaped its root.");
      const stat = await NodeFSP.stat(payloadPath);
      if (Number(stat.size) !== file.sizeBytes || (await sha256File(payloadPath)) !== file.sha256) {
        throw new Error(
          `Native session payload '${file.relativePath}' failed integrity validation.`,
        );
      }
      const targetPath = NodePath.resolve(
        input.destinationHomePath,
        await installRelativePath(input, file),
      );
      const destinationRoot = `${NodePath.resolve(input.destinationHomePath)}${NodePath.sep}`;
      if (!targetPath.startsWith(destinationRoot)) {
        throw new Error("The native session destination escaped its home.");
      }
      const targetExists = await NodeFSP.lstat(targetPath).then(
        () => true,
        (error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        },
      );
      if (targetExists && input.replacementDirectory === undefined)
        throw new Error(`Native session destination '${targetPath}' already exists.`);
      const backupPath =
        targetExists && input.replacementDirectory !== undefined
          ? NodePath.join(input.replacementDirectory, `${String(file.payloadPath)}.previous`)
          : undefined;
      if (backupPath !== undefined) {
        await NodeFSP.lstat(backupPath).then(
          () => {
            throw new Error(`Native session backup '${backupPath}' already exists.`);
          },
          (error) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          },
        );
      }
      return { file, payloadPath, targetPath, backupPath };
    }),
  );
  const matchingTranscripts = await Promise.all(
    prepared
      .filter((item) =>
        input.archive.driver === "claude"
          ? item.file.relativePath === `${input.archive.nativeThreadId}.jsonl`
          : item.file.relativePath.endsWith(".jsonl"),
      )
      .map((item) => fileBelongsToSession(item.payloadPath, input.archive.nativeThreadId)),
  );
  if (matchingTranscripts.filter(Boolean).length !== 1) {
    throw new Error("The native session payload does not match the requested session id.");
  }

  await NodeFSP.mkdir(input.destinationHomePath, { recursive: true, mode: 0o700 });
  const temporaryFiles: Array<string> = [];
  const installedFiles: Array<string> = [];
  const replacedFiles: Array<{ readonly targetPath: string; readonly backupPath: string }> = [];
  try {
    if (input.replacementDirectory !== undefined)
      await NodeFSP.mkdir(input.replacementDirectory, { recursive: true, mode: 0o700 });
    for (const item of prepared) {
      if (item.backupPath === undefined) continue;
      await NodeFSP.mkdir(NodePath.dirname(item.backupPath), { recursive: true, mode: 0o700 });
      await NodeFSP.rename(item.targetPath, item.backupPath);
      replacedFiles.push({ targetPath: item.targetPath, backupPath: item.backupPath });
    }
    for (const [index, item] of prepared.entries()) {
      await assertSafeParent(input.destinationHomePath, item.targetPath);
      const temporaryPath = `${item.targetPath}.t3-move-${process.pid}-${index}.part`;
      temporaryFiles.push(temporaryPath);
      await NodeFSP.copyFile(item.payloadPath, temporaryPath, NodeFS.constants.COPYFILE_EXCL);
      await NodeFSP.chmod(temporaryPath, item.file.mode);
    }
    for (const [index, item] of prepared.entries()) {
      const temporaryPath = temporaryFiles[index]!;
      await NodeFSP.link(temporaryPath, item.targetPath);
      installedFiles.push(item.targetPath);
      await NodeFSP.rm(temporaryPath);
    }
  } catch (error) {
    await Promise.all([
      ...temporaryFiles.map((filePath) => NodeFSP.rm(filePath, { force: true })),
      ...installedFiles.map((filePath) => NodeFSP.rm(filePath, { force: true })),
    ]);
    for (const replaced of replacedFiles.toReversed())
      await NodeFSP.rename(replaced.backupPath, replaced.targetPath);
    throw error;
  }
  return async () => {
    for (const installedFile of installedFiles.toReversed()) {
      await NodeFSP.rm(installedFile, { force: true });
    }
    for (const replaced of replacedFiles.toReversed())
      await NodeFSP.rename(replaced.backupPath, replaced.targetPath);
  };
}
