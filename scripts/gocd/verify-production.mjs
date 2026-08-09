import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const port = process.env.T3_PRODUCTION_PORT ?? "17774";
const runtimeRoot = resolve(process.env.T3_PIPELINE_RUNTIME_ROOT ?? join(homedir(), "t3-runtime"));
try {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Production returned HTTP ${response.status}.`);
  const current = join(runtimeRoot, "production", "current");
  if (!existsSync(current)) throw new Error("Production has no current release.");
  const release = realpathSync(current);
  for (const requiredPath of [
    join(release, "manifest.json"),
    join(release, "apps", "desktop", "scripts", "start-electron.mjs"),
    join(release, "apps", "desktop", "node_modules", "electron", "package.json"),
    join(release, "apps", "server", "dist", "bin.mjs"),
  ]) {
    if (!existsSync(requiredPath))
      throw new Error(`Production release is missing ${requiredPath}.`);
  }
  console.log(`[t3-pipeline] production smoke check passed on port ${port}`);
} catch (error) {
  const rollback = spawnSync(
    process.execPath,
    ["scripts/gocd/local-pipeline.mjs", "rollback", "production"],
    {
      cwd: process.cwd(),
      stdio: "inherit",
    },
  );
  if (rollback.status !== 0)
    console.error("[t3-pipeline] production rollback was unavailable or failed.");
  throw error;
}
