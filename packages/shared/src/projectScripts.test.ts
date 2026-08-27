import type { ProjectScript, T3ProjectFileScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  fileScriptToProjectScript,
  projectScriptsMatch,
  resolveProjectScripts,
} from "./projectScripts.ts";

const script = (id: string, name: string, command: string): ProjectScript => ({
  id,
  name,
  command,
  icon: "play",
  runOnWorktreeCreate: false,
});

describe("resolveProjectScripts", () => {
  const fileScript = (
    name: string,
    command: string,
    overrides: Partial<T3ProjectFileScript> = {},
  ): T3ProjectFileScript => ({ name, command, ...overrides });

  it("orders project, t3.json, and global actions by precedence", () => {
    expect(
      resolveProjectScripts(
        [script("dev", "Dev", "vp dev")],
        [fileScript("Lint", "vp lint")],
        [script("global-test", "Test", "vp test")],
        [],
      ),
    ).toEqual([
      script("dev", "Dev", "vp dev"),
      fileScriptToProjectScript(fileScript("Lint", "vp lint")),
      script("global-test", "Test", "vp test"),
    ]);
  });

  it("lets each higher layer override lower layers", () => {
    const project = script("custom-lint", "Checks", "vp lint");
    const file = fileScript("Lint", "vp lint");
    const global = script("global-lint", "LINT", "global lint");
    expect(resolveProjectScripts([project], [file], [], [])).toEqual([project]);
    expect(resolveProjectScripts([], [file], [global], [])).toEqual([
      fileScriptToProjectScript(file),
    ]);
    expect(projectScriptsMatch(file, project)).toBe(true);
    expect(projectScriptsMatch(global, file)).toBe(true);
  });

  it("excludes disabled inherited actions and restores them when ids are removed", () => {
    const file = fileScript("Lint", "vp lint");
    const normalizedFile = fileScriptToProjectScript(file);
    const global = script("global-test", "Test", "vp test");
    expect(resolveProjectScripts([], [file], [global], [normalizedFile.id, global.id])).toEqual([]);
    expect(resolveProjectScripts([], [file], [global], [])).toEqual([normalizedFile, global]);
  });

  it("never disables project actions and keeps them when inherited actions reuse identity", () => {
    const project = script("dev", "Project dev", "project-dev");
    const global = script("dev", "Global dev", "global-dev");
    expect(resolveProjectScripts([project], [], [global], [project.id])).toEqual([project]);
  });

  it("normalizes optional t3.json fields into a runnable action", () => {
    expect(
      fileScriptToProjectScript(
        fileScript("  Dev Server  ", "vp dev", {
          previewUrl: "http://localhost:3000",
          autoOpenPreview: true,
        }),
      ),
    ).toEqual({
      id: "file:dev server",
      name: "  Dev Server  ",
      command: "vp dev",
      icon: "play",
      runOnWorktreeCreate: false,
      previewUrl: "http://localhost:3000",
      autoOpenPreview: true,
    });
  });
});
