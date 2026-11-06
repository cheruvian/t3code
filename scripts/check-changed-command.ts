// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";

export function vitePlusCommand(
  args: ReadonlyArray<string>,
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node tooling has no Effect runtime; tests pass the platform explicitly.
  platform: NodeJS.Platform = process.platform,
): [command: string, args: Array<string>] {
  // Windows cannot spawn the package manager's vp.cmd shim without a shell.
  // Use Vite+'s exported JS entry with this Node instead, keeping paths and
  // arguments literal. Resolve here, not from the patch check's temporary cwd.
  if (platform === "win32") {
    return [
      process.execPath,
      [NodeURL.fileURLToPath(import.meta.resolve("vite-plus/bin")), ...args],
    ];
  }
  return ["vp", [...args]];
}

// Leave room for the environment and launcher on platforms with small exec argument limits.
export function batchArguments(
  args: ReadonlyArray<string>,
  maxItems = Number.POSITIVE_INFINITY,
): Array<Array<string>> {
  const batches: Array<Array<string>> = [];
  let batch: Array<string> = [];
  let bytes = 0;
  for (const arg of args) {
    const size = Buffer.byteLength(arg) + 8;
    if (batch.length > 0 && (bytes + size > 16000 || batch.length >= maxItems)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(arg);
    bytes += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}
