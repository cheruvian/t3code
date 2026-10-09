// @effect-diagnostics nodeBuiltinImport:off - Exercise the compiler CLI against a real temporary project.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

it("preserves the caller's project, compiler arguments, and diagnostic exit codes", () => {
  const project = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-effect-typescript-"));
  try {
    NodeFS.writeFileSync(
      NodePath.join(project, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          skipLibCheck: true,
          plugins: [
            {
              name: "@effect/language-service",
              diagnosticSeverity: { globalDate: "error" },
            },
          ],
        },
        files: ["case.ts"],
      }),
    );
    const check = () =>
      NodeChildProcess.spawnSync(
        process.execPath,
        [NodeURL.fileURLToPath(new URL("./effect-typescript.ts", import.meta.url)), "--noEmit"],
        { cwd: project, encoding: "utf8" },
      );
    NodeFS.writeFileSync(
      NodePath.join(project, "case.ts"),
      "export const created = new Date();\nexport const invalid: string = 123;\n",
    );
    const invalid = check();
    expect(invalid.error).toBeUndefined();
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toContain("TS2322");
    expect(invalid.stdout).toContain("effect(globalDate)");

    NodeFS.writeFileSync(NodePath.join(project, "case.ts"), "export const valid: string = 'ok';\n");
    const valid = check();
    expect(valid.error).toBeUndefined();
    expect(valid.status).toBe(0);
    expect(valid.stdout).toBe("");
    expect(NodeFS.existsSync(NodePath.join(project, "case.js"))).toBe(false);
  } finally {
    NodeFS.rmSync(project, { recursive: true, force: true });
  }
});
