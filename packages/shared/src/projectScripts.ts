import type { ProjectScript, T3ProjectFileScript } from "@t3tools/contracts";

interface ProjectScriptRuntimeEnvInput {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}

export function projectScriptCwd(input: {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
}): string {
  return input.worktreePath ?? input.project.cwd;
}

export function projectScriptRuntimeEnv(
  input: ProjectScriptRuntimeEnvInput,
): Record<string, string> {
  const env: Record<string, string> = {
    T3CODE_PROJECT_ROOT: input.project.cwd,
  };
  if (input.worktreePath) {
    env.T3CODE_WORKTREE_PATH = input.worktreePath;
  }
  if (input.extraEnv) {
    return { ...env, ...input.extraEnv };
  }
  return env;
}

export function setupProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}

export function projectScriptsMatch(
  left: Pick<ProjectScript, "name" | "command">,
  right: Pick<ProjectScript, "name" | "command">,
): boolean {
  return left.command === right.command || left.name.toLowerCase() === right.name.toLowerCase();
}

export function fileScriptToProjectScript(fileScript: T3ProjectFileScript): ProjectScript {
  return {
    id: `file:${fileScript.name.trim().toLowerCase()}`,
    name: fileScript.name,
    command: fileScript.command,
    icon: fileScript.icon ?? "play",
    runOnWorktreeCreate: fileScript.runOnWorktreeCreate ?? false,
    ...(fileScript.previewUrl === undefined ? {} : { previewUrl: fileScript.previewUrl }),
    ...(fileScript.autoOpenPreview === undefined
      ? {}
      : { autoOpenPreview: fileScript.autoOpenPreview }),
  };
}

export function resolveProjectScripts(
  projectScripts: readonly ProjectScript[],
  fileScripts: readonly T3ProjectFileScript[],
  globalScripts: readonly ProjectScript[],
  disabledInheritedScriptIds: readonly string[],
): ProjectScript[] {
  const disabled = new Set(disabledInheritedScriptIds);
  const resolved = [...projectScripts];
  const appendInherited = (script: ProjectScript) => {
    if (
      !disabled.has(script.id) &&
      !resolved.some(
        (resolvedScript) =>
          resolvedScript.id === script.id || projectScriptsMatch(resolvedScript, script),
      )
    ) {
      resolved.push(script);
    }
  };
  fileScripts.map(fileScriptToProjectScript).forEach(appendInherited);
  globalScripts.forEach(appendInherited);
  return resolved;
}
