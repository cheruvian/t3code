// @effect-diagnostics nodeBuiltinImport:off - This launcher executes the native compiler.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

const require = NodeModule.createRequire(import.meta.url);
const cli = NodePath.join(
  NodePath.dirname(require.resolve("@effect/tsgo/package.json")),
  "dist",
  "effect-tsgo.cjs",
);
// The package runs its compiler without mutating the shared dependency graph.
const args =
  process.argv[2] === "--prepare" ? ["tsrs", "--version"] : ["tsrs", ...process.argv.slice(2)];
const result = NodeChildProcess.spawnSync(process.execPath, [cli, ...args], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;
