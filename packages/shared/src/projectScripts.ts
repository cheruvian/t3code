import type {
  ProjectId,
  ProjectScript,
  ServerSettings,
  T3ProjectFileScript,
} from "@t3tools/contracts";

type ProjectScriptSettings = Pick<
  ServerSettings,
  | "defaultProjectScripts"
  | "projectScriptOverrides"
  | "projectSettingsOverrides"
  | "projectSettingsFolded"
>;

/**
 * The project's override wins, then environment defaults. Until the legacy
 * fields have been folded into `projectSettingsOverrides`, the old map (null
 * there meant "reset to machine defaults") and the aggregate's own scripts
 * still count, so a server that has not run the fold yet behaves as before.
 */
export function resolveProjectScripts(
  settings: ProjectScriptSettings,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): readonly ProjectScript[] {
  const override = settings.projectSettingsOverrides[project.id]?.defaultProjectScripts;
  if (override !== undefined) return override;
  if (settings.projectSettingsFolded) return settings.defaultProjectScripts;
  const legacy = settings.projectScriptOverrides[project.id];
  if (legacy === null) return settings.defaultProjectScripts;
  return legacy ?? (project.scripts.length > 0 ? project.scripts : settings.defaultProjectScripts);
}

export function projectScriptsInheritDefaults(
  settings: ProjectScriptSettings,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): boolean {
  if (settings.projectSettingsOverrides[project.id]?.defaultProjectScripts !== undefined) {
    return false;
  }
  if (settings.projectSettingsFolded) return true;
  const legacy = settings.projectScriptOverrides[project.id];
  return legacy === null || (legacy === undefined && project.scripts.length === 0);
}

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
  return scripts.find((script) => script.runOnWorktreeCreate && !script.resource) ?? null;
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
    ...(fileScript.resource ? { resource: fileScript.resource } : {}),
    icon: fileScript.icon ?? "play",
    runOnWorktreeCreate: fileScript.runOnWorktreeCreate ?? false,
    ...(fileScript.previewUrl === undefined ? {} : { previewUrl: fileScript.previewUrl }),
    ...(fileScript.autoOpenPreview === undefined
      ? {}
      : { autoOpenPreview: fileScript.autoOpenPreview }),
  };
}

export function resolveInheritedProjectScripts(
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
