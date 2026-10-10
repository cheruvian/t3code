// @effect-diagnostics nodeBuiltinImport:off - This launcher prepares and executes the native compiler.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const sdk = NodePath.join(root, "node_modules", ".effect-tsgo");
const marker = NodePath.join(sdk, "source");

function prepareCompiler() {
  const require = NodeModule.createRequire(import.meta.url);
  const cli = NodePath.join(
    NodePath.dirname(require.resolve("@effect/tsgo/package.json")),
    "dist",
    "effect-tsgo.cjs",
  );
  // The CLI selects the artifact matching installed TypeScript without patching it.
  const source = NodeChildProcess.execFileSync(process.execPath, [cli, "get-exe-path"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  const compiler = NodePath.join(sdk, NodePath.basename(source));
  if (
    NodeFS.existsSync(compiler) &&
    NodeFS.existsSync(marker) &&
    NodeFS.readFileSync(marker, "utf8") === source
  )
    return;
  NodeFS.mkdirSync(sdk, { recursive: true });
  const temporary = `${compiler}.${process.pid}.tmp`;
  const temporaryMarker = `${marker}.${process.pid}.tmp`;
  try {
    NodeFS.copyFileSync(source, temporary, NodeFS.constants.COPYFILE_FICLONE);
    NodeFS.writeFileSync(temporaryMarker, source);
    NodeFS.renameSync(temporary, compiler);
    NodeFS.renameSync(temporaryMarker, marker);
  } finally {
    NodeFS.rmSync(temporary, { force: true });
    NodeFS.rmSync(temporaryMarker, { force: true });
  }
}

if (process.argv[2] === "--prepare") {
  prepareCompiler();
} else {
  if (!NodeFS.existsSync(marker))
    throw new Error("Run pnpm install to prepare the Effect TypeScript compiler.");
  const compiler = NodePath.join(sdk, NodePath.basename(NodeFS.readFileSync(marker, "utf8")));
  const result = NodeChildProcess.spawnSync(compiler, process.argv.slice(2), { stdio: "inherit" });
  if (result.error)
    throw new Error("Run pnpm install to prepare the Effect TypeScript compiler.", {
      cause: result.error,
    });
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.status ?? 1;
}
