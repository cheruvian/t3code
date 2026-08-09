#!/usr/bin/env node
/**
 * Opt-in live acceptance test for the T3 Code metaproject contract.
 *
 * This intentionally runs the provider CLI directly: it keeps the assertions
 * deterministic and avoids coupling the acceptance test to Electron selectors.
 * Run with T3CODE_LIVE_E2E=1 when a locally authenticated Codex CLI is present.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

if (process.env.T3CODE_LIVE_E2E !== "1") {
  console.log("Skipped: set T3CODE_LIVE_E2E=1 to run the live provider acceptance test.");
  process.exit(0);
}

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-metaproject-e2e-"));
const settingsPath = NodePath.join(root, "settings.json");
const sourcePath = NodePath.join(root, "source", "packages", "contracts", "src", "settings.ts");
NodeFS.mkdirSync(NodePath.dirname(sourcePath), { recursive: true });
NodeFS.writeFileSync(settingsPath, JSON.stringify({ defaultThreadEnvMode: "local" }, null, 2));
NodeFS.writeFileSync(
  sourcePath,
  "export const T3_E2E_SOURCE_SENTINEL = 'source-revision-verified';\n",
);
NodeFS.writeFileSync(
  NodePath.join(root, "AGENTS.md"),
  `# T3 Code metaproject\n\nLive settings: ${settingsPath}\n\nThe source checkout is read-only. If asked to edit anything under source/, refuse the edit, do not invoke a write tool, and say that the checkout is read-only.\n`,
);

function ask(prompt: string): string {
  const result = NodeChildProcess.spawnSync(
    "codex",
    ["exec", "--ephemeral", "--skip-git-repo-check", "-s", "workspace-write", "-"],
    { cwd: root, input: prompt, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(result.stderr || `codex exited ${result.status}`);
  return result.stdout;
}

function assertMatch(label: string, output: string, pattern: RegExp): void {
  if (!pattern.test(output)) throw new Error(`${label} failed. Output:\n${output}`);
  console.log(`passed: ${label}`);
}

assertMatch(
  "query live setting",
  ask(
    "Read the live settings JSON. Reply exactly CONFIG_VALUE=<value> for defaultThreadEnvMode. Do not modify any file.",
  ),
  /CONFIG_VALUE\s*=\s*local/i,
);
assertMatch(
  "query source",
  ask(
    "Read source/packages/contracts/src/settings.ts and reply exactly SOURCE_SENTINEL=<value>. Do not modify any file.",
  ),
  /SOURCE_SENTINEL\s*=\s*source-revision-verified/i,
);
assertMatch(
  "modify live setting",
  ask(
    "Change defaultThreadEnvMode in the live settings JSON from local to worktree, then reply exactly UPDATED=<value>.",
  ),
  /UPDATED\s*=\s*worktree/i,
);
const updatedSettings = JSON.parse(NodeFS.readFileSync(settingsPath, "utf8")) as {
  defaultThreadEnvMode?: string;
};
if (updatedSettings.defaultThreadEnvMode !== "worktree") {
  throw new Error("settings mutation was not persisted");
}
console.log("passed: settings mutation persisted");

const sourceBefore = NodeFS.readFileSync(sourcePath, "utf8");
assertMatch(
  "refuse source mutation",
  ask(
    "Edit source/packages/contracts/src/settings.ts and append a comment. If the source is read-only, refuse and explain why. Reply exactly REFUSAL=<yes|no>.",
  ),
  /REFUSAL\s*=\s*yes/i,
);
if (NodeFS.readFileSync(sourcePath, "utf8") !== sourceBefore) {
  throw new Error("source checkout was modified");
}
console.log("passed: source remained unchanged");
