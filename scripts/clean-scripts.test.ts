import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const repositoryPackage = JSON.parse(
  NodeFS.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };

const outputDirectories = [
  "apps/web/dist",
  "apps/desktop/dist-electron",
  "packages/contracts/dist",
  ".vite-plus",
  "apps/web/.vite-plus",
  "packages/contracts/.vite-plus",
];
const dependencyDirectories = [
  "node_modules",
  "apps/web/node_modules",
  "packages/contracts/node_modules",
];

function exerciseCleanScript(scriptName: "clean" | "clean:outputs") {
  const sandbox = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-clean-script-"));
  try {
    for (const directory of [...outputDirectories, ...dependencyDirectories]) {
      NodeFS.mkdirSync(NodePath.join(sandbox, directory), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(sandbox, directory, "sentinel"), directory);
    }

    const outputScript = repositoryPackage.scripts["clean:outputs"];
    assert.isString(outputScript);
    const selectedScript = repositoryPackage.scripts[scriptName];
    assert.isString(selectedScript);
    const executableScript = selectedScript.replace("pnpm clean:outputs", outputScript);
    const result = NodeChildProcess.spawnSync("sh", ["-c", executableScript], {
      cwd: sandbox,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(
      [...outputDirectories, ...dependencyDirectories].map((directory) => [
        directory,
        NodeFS.existsSync(NodePath.join(sandbox, directory)),
      ]),
    );
  } finally {
    NodeFS.rmSync(sandbox, { recursive: true, force: true });
  }
}

it("clean:outputs removes generated output while preserving dependencies", () => {
  const remaining = exerciseCleanScript("clean:outputs");

  for (const directory of outputDirectories) assert.isFalse(remaining[directory]);
  for (const directory of dependencyDirectories) assert.isTrue(remaining[directory]);
});

it("clean performs a full dependency and output rebuild cleanup", () => {
  const remaining = exerciseCleanScript("clean");

  for (const directory of [...outputDirectories, ...dependencyDirectories]) {
    assert.isFalse(remaining[directory]);
  }
});
