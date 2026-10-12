// A detached, credential-free timer survives an unexpected broker exit.
import { unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";

const [file, deadline] = process.argv.slice(2);
if (
  !file ||
  basename(dirname(file)) !== "leases" ||
  !/^lease-[a-f0-9-]{36}\.secret$/.test(basename(file)) ||
  !Number.isFinite(Number(deadline))
)
  process.exit(1);
setTimeout(
  async () => {
    try {
      await unlink(file);
    } catch (error) {
      if (error.code !== "ENOENT") process.exitCode = 1;
    }
  },
  Math.max(0, Number(deadline) - Date.now()),
);
