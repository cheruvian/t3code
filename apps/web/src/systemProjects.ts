import type { EnvironmentId } from "@t3tools/contracts";
import type { SidebarProjectSnapshot } from "./sidebarProjectGrouping";

type EnvironmentConfig = {
  readonly environment: {
    readonly t3CodeProjectRoot?: string;
  };
};

type ProjectThread = {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
};

export function isT3CodeSystemProject(
  project: SidebarProjectSnapshot,
  serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentConfig>,
) {
  return project.memberProjects.some(
    (member) =>
      serverConfigs.get(member.environmentId)?.environment.t3CodeProjectRoot ===
      member.workspaceRoot,
  );
}

export function hasThreadForProject(
  project: SidebarProjectSnapshot,
  threads: ReadonlyArray<ProjectThread>,
) {
  return project.memberProjectRefs.some((member) =>
    threads.some(
      (thread) =>
        thread.environmentId === member.environmentId && thread.projectId === member.projectId,
    ),
  );
}
