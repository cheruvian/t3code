import type { EnvironmentProject } from "./models.ts";
import {
  buildProjectGroups,
  derivePhysicalProjectKey,
  type ProjectGroupingSettings,
} from "./projectGrouping.ts";
import type { EnvironmentId, ProjectResourceLock } from "@t3tools/contracts";

export interface GroupedResourceLock {
  readonly project: EnvironmentProject;
  readonly lock: ProjectResourceLock;
}

/** Uses the same project groups as the sidebar, including its per-project overrides. */
export function groupedResourceLocks(input: {
  readonly activeProject: EnvironmentProject;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly settings: ProjectGroupingSettings;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
}): ReadonlyArray<GroupedResourceLock> {
  const group = buildProjectGroups({
    projects: input.projects,
    settings: input.settings,
    preferredEnvironmentId: input.primaryEnvironmentId,
  }).find((candidate) =>
    candidate.members.some(
      (member) => member.physicalProjectKey === derivePhysicalProjectKey(input.activeProject),
    ),
  );
  if (!group) return [];
  const refs = new Set(
    group.memberProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`),
  );
  return input.projects.flatMap((project) => {
    if (
      !refs.has(`${project.environmentId}:${project.id}`) ||
      !input.connectedEnvironmentIds.has(project.environmentId)
    )
      return [];
    return (project.resourceLocks ?? []).map((lock) => ({ project, lock }));
  });
}
