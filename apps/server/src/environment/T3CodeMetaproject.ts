import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import packageJson from "../../package.json" with { type: "json" };
import { agentApiInventoryJson } from "@t3tools/contracts";
import {
  getEmbeddedT3CodeCommit,
  normalizeT3CodeCommit,
  t3CodeCommitsMatch,
} from "../buildIdentity.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

const instructions = (input: {
  readonly settingsPath: string;
  readonly keybindingsPath: string;
  readonly commit: string | null;
}) => `# T3 Code metaproject

This workspace exists to query and manage the T3 Code environment that launched you. It is not an ordinary user project.

## Live configuration

- Server settings: \`${input.settingsPath}\`
- Keybindings: \`${input.keybindingsPath}\`
- Typed API inventory: \`api-inventory.json\` (generated from the running contracts)

Read a file before changing it, preserve valid JSON, and make the smallest change that satisfies the request. A missing file means T3 Code is using its defaults; create the file only when a requested change needs persisted configuration. The server watches both files and reloads valid edits. Never modify the state database, authentication material, runtime identifiers, logs, attachments, caches, or worktrees unless the user explicitly asks for that exact operation.

When the user asks what a setting currently does, inspect the live value first. Explain defaults separately from configured values. Prefer the Settings UI when it supports the requested change; direct file edits are appropriate when the user asks you to make the change from this project.

## Managing T3 Code

This project may also manage the environment itself. The generated \`api-inventory.json\` lists every typed RPC and orchestration API known by this server, including whether it is read-only, mutating, or destructive and whether it is agent-exposed or UI-only. Projects can be added, renamed, or removed with the installed CLI (\`t3 project add\`, \`t3 project rename\`, and \`t3 project remove\`); use \`t3 project --help\` first and preserve the environment's data-directory flags. Actions and keybindings live in the keybindings file above. Provider settings, general settings, and other server configuration live in the settings file above. Confirm destructive project removals before executing them, and never edit the state database directly.

## Product knowledge

Running server version: \`${packageJson.version}\`${
  input.commit === null
    ? ""
    : `  
Running source commit: \`${input.commit}\``
}

Use sources in this order:

1. The canonical user documentation at https://github.com/pingdotgg/t3code/tree/main/docs/user.
2. Internal documentation at https://github.com/pingdotgg/t3code/tree/main/docs/internals when the question is architectural.
3. The T3 Code source only when the documentation does not answer the question.
${
  input.commit === null
    ? "The exact source revision is unavailable in this build. State that limitation before inferring behavior from the upstream repository."
    : `When source inspection is necessary, run \`node checkout-source.mjs\` first. It creates \`source/\` at the exact running commit and makes the checkout read-only. Never change permissions or modify files under \`source/\`. Its settings contracts are in \`source/packages/contracts/src/settings.ts\`.`
}

Distinguish documented behavior from conclusions inferred from source. If asked to edit anything under \`source/\`, refuse the edit, do not invoke a write tool, and say that the checkout is read-only. Open a separate normal project if the user asks for a T3 Code product change.
`;

const checkoutScript = (
  commit: string,
  sourceUrl: string,
) => `import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const commit = ${JSON.stringify(commit)};
const sourceUrl = ${JSON.stringify(sourceUrl)};
const target = resolve("source");

function run(args) {
  const result = spawnSync("git", args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function chmodTree(path, directoryMode, fileMode) {
  if (!existsSync(path)) return;
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) return;
  chmodSync(path, entry.isDirectory() ? directoryMode : fileMode);
  if (entry.isDirectory()) {
    for (const child of readdirSync(path)) chmodTree(resolve(path, child), directoryMode, fileMode);
  }
}

if (existsSync(resolve(target, ".git"))) chmodTree(target, 0o755, 0o644);
else run(["clone", "--no-checkout", sourceUrl, target]);
run(["-C", target, "fetch", "origin", commit]);
run(["-C", target, "checkout", "--detach", "--force", commit]);
chmodTree(target, 0o555, 0o444);
console.log(\`Read-only T3 Code source ready at \${target} (\${commit}).\`);
`;

export const ensureT3CodeMetaproject = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const localCommit = yield* processRunner
    .run({ command: "git", args: ["rev-parse", "HEAD"], cwd: config.cwd, timeout: "5 seconds" })
    .pipe(
      Effect.map((result) => (result.code === 0 ? normalizeT3CodeCommit(result.stdout) : null)),
      Effect.orElseSucceed(() => null),
    );
  const commit = getEmbeddedT3CodeCommit() ?? localCommit;
  const sourceMarker = path.join(config.cwd, "packages", "contracts", "src", "settings.ts");
  const sourceUrl =
    (yield* fs.exists(sourceMarker)) && t3CodeCommitsMatch(localCommit, commit)
      ? config.cwd
      : "https://github.com/pingdotgg/t3code.git";

  yield* fs.makeDirectory(config.t3CodeProjectDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(config.t3CodeProjectDir, "AGENTS.md"),
    instructions({
      settingsPath: config.settingsPath,
      keybindingsPath: config.keybindingsConfigPath,
      commit,
    }),
  );
  if (commit !== null) {
    const checkoutScriptPath = path.join(config.t3CodeProjectDir, "checkout-source.mjs");
    yield* fs.writeFileString(checkoutScriptPath, checkoutScript(commit, sourceUrl));
    yield* fs.chmod(checkoutScriptPath, 0o755);
  }
  yield* fs.writeFileString(
    path.join(config.t3CodeProjectDir, "README.md"),
    "# T3 Code\n\nAsk an agent in this project to inspect, explain, or change this environment's T3 Code configuration.\n",
  );
  yield* fs.writeFileString(
    path.join(config.t3CodeProjectDir, "api-inventory.json"),
    agentApiInventoryJson(),
  );

  return config.t3CodeProjectDir;
});
