// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

const MAGIC = Buffer.from("T3MOVE1\n");
const CHUNK_BYTES = 1024 * 1024;
export async function hashMoveFile(filePath: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
export async function writeMoveJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    const handle = await NodeFSP.open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await NodeFSP.rename(temporary, filePath);
    try {
      const directory = await NodeFSP.open(NodePath.dirname(filePath), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      // Some filesystems cannot open or sync directories; the file itself is already synced.
      if (
        !["EISDIR", "EPERM", "EINVAL", "ENOTSUP"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}
function safeName(name: unknown): string {
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,150}$/.test(name)) {
    throw new Error("Invalid move archive file name.");
  }
  return name;
}
async function writeAll(handle: NodeFSP.FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) offset += (await handle.write(bytes, offset)).bytesWritten;
}
export async function packMoveArchive(directory: string, outputPath: string): Promise<void> {
  const files = (await NodeFSP.readdir(directory)).toSorted();
  const output = await NodeFSP.open(outputPath, "wx", 0o600);
  try {
    await writeAll(output, MAGIC);
    for (const name of files) {
      safeName(name);
      const filePath = NodePath.join(directory, name);
      const stat = await NodeFSP.lstat(filePath);
      if (!stat.isFile()) throw new Error("Move archive payloads must be regular files.");
      const header = Buffer.from(
        JSON.stringify({ name, size: stat.size, sha256: await hashMoveFile(filePath) }),
      );
      const length = Buffer.alloc(4);
      length.writeUInt32BE(header.length);
      await writeAll(output, length);
      await writeAll(output, header);
      for await (const chunk of NodeFS.createReadStream(filePath)) await writeAll(output, chunk);
    }
    await output.sync();
  } finally {
    await output.close();
  }
}
/** Extracts only generated flat payload names, streaming large bodies with bounded memory. */
export async function unpackMoveArchive(inputPath: string, directory: string): Promise<void> {
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const input = await NodeFSP.open(inputPath, "r");
  const created: string[] = [];
  try {
    const size = (await input.stat()).size;
    let position = 0;
    async function read(count: number): Promise<Buffer> {
      const buffer = Buffer.alloc(count);
      let offset = 0;
      while (offset < count) {
        const result = await input.read(buffer, offset, count - offset, position);
        if (result.bytesRead === 0) throw new Error("Truncated move archive.");
        offset += result.bytesRead;
        position += result.bytesRead;
      }
      return buffer;
    }
    if (!(await read(MAGIC.length)).equals(MAGIC)) throw new Error("Unsupported move archive.");
    while (position < size) {
      const length = (await read(4)).readUInt32BE();
      if (length < 1 || length > 4096) throw new Error("Invalid move archive header.");
      const header: unknown = JSON.parse((await read(length)).toString("utf8"));
      if (typeof header !== "object" || header === null)
        throw new Error("Invalid move archive header.");
      const fields = header as Record<string, unknown>;
      const name = safeName(fields["name"]),
        bytes = fields["size"],
        expected = fields["sha256"];
      if (
        typeof bytes !== "number" ||
        !Number.isSafeInteger(bytes) ||
        bytes < 0 ||
        position + bytes > size
      ) {
        throw new Error("Invalid move archive size.");
      }
      const filePath = NodePath.join(directory, name);
      const output = await NodeFSP.open(filePath, "wx", 0o600);
      created.push(filePath);
      const hash = NodeCrypto.createHash("sha256");
      try {
        let remaining = bytes;
        while (remaining > 0) {
          const chunk = await read(Math.min(CHUNK_BYTES, remaining));
          hash.update(chunk);
          await writeAll(output, chunk);
          remaining -= chunk.length;
        }
        await output.sync();
      } finally {
        await output.close();
      }
      if (hash.digest("hex") !== expected) throw new Error("Move archive integrity check failed.");
    }
  } catch (error) {
    for (const filePath of created) await NodeFSP.rm(filePath, { force: true });
    throw error;
  } finally {
    await input.close();
  }
}
