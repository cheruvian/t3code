import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { serverEnvironment } from "../state/server";
import { useProject } from "../state/entities";
import { EnvironmentMachineSymbol } from "./EnvironmentMachineSymbol";
import { ProjectFavicon } from "./ProjectFavicon";

export function EnvironmentIcon(props: {
  readonly environmentId: EnvironmentId;
  readonly kind: EnvironmentMachineKind;
  readonly size: number;
  readonly tintColorClassName: string;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const projectId = config?.settings.environmentIconProjectId;
  const project = useProject(projectId ? { environmentId: props.environmentId, projectId } : null);
  return project ? (
    <ProjectFavicon
      environmentId={props.environmentId}
      projectTitle={project.title}
      workspaceRoot={project.workspaceRoot}
      projectIcon={project.projectIcon}
      faviconPath={project.faviconPath}
      size={props.size}
    />
  ) : (
    <EnvironmentMachineSymbol
      kind={props.kind}
      size={props.size}
      tintColorClassName={props.tintColorClassName}
    />
  );
}
