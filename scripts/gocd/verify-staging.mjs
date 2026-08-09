import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const port = process.env.T3_STAGING_PORT ?? "17773";
const runtimeRoot = resolve(process.env.T3_PIPELINE_RUNTIME_ROOT ?? join(homedir(), "t3-runtime"));
const expectedProjectRoot = join(runtimeRoot, "staging", "home", "t3code");
try {
  const response = await fetch(`http://127.0.0.1:${port}/`);
  if (!response.ok) throw new Error(`Staging returned HTTP ${response.status}.`);
  const descriptorResponse = await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`);
  if (!descriptorResponse.ok) {
    throw new Error(`Staging environment descriptor returned HTTP ${descriptorResponse.status}.`);
  }
  const descriptor = await descriptorResponse.json();
  if (descriptor.t3CodeProjectRoot !== expectedProjectRoot) {
    throw new Error(
      "Staging did not publish the expected T3 Code metaproject workspace in its environment descriptor.",
    );
  }
  if (!existsSync(join(expectedProjectRoot, "AGENTS.md"))) {
    throw new Error("Staging did not materialize the T3 Code metaproject instructions.");
  }
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
