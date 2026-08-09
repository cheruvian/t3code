import { spawnSync } from "node:child_process";

const port = process.env.T3_PRODUCTION_PORT ?? "17774";
try {
  const response = await fetch(`http://127.0.0.1:${port}/`);
  if (!response.ok) throw new Error(`Production returned HTTP ${response.status}.`);
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
