import { spawnSync } from "node:child_process";

const port = process.env.T3_STAGING_PORT ?? "17773";
try {
  const response = await fetch(`http://127.0.0.1:${port}/`);
  if (!response.ok) throw new Error(`Staging returned HTTP ${response.status}.`);
  console.log(`[t3-pipeline] staging smoke check passed on port ${port}`);
} catch (error) {
  const rollback = spawnSync(
    process.execPath,
    ["scripts/gocd/local-pipeline.mjs", "rollback", "staging"],
    {
      cwd: process.cwd(),
      stdio: "inherit",
    },
  );
  if (rollback.status !== 0)
    console.error("[t3-pipeline] staging rollback was unavailable or failed.");
  throw error;
}
