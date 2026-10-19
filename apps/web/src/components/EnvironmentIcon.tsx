import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import type { LucideProps } from "lucide-react";
import { useEnvironment } from "../state/environments";
import { useProject } from "../state/entities";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { cn } from "../lib/utils";
import { ProjectFavicon } from "./ProjectFavicon";

export function EnvironmentIcon({
  environmentId,
  kind,
  ...props
}: LucideProps & {
  readonly environmentId: EnvironmentId | null;
  readonly kind: EnvironmentMachineKind;
}) {
  const environment = useEnvironment(environmentId);
  const projectId = environment?.serverConfig?.settings.environmentIconProjectId;
  const project = useProject(projectId && environmentId ? { environmentId, projectId } : null);
  return project ? (
    <span
      className={cn("inline-flex size-4 shrink-0", props.className)}
      aria-hidden={props["aria-hidden"]}
    >
      <ProjectFavicon project={project} className="size-full" />
    </span>
  ) : (
    <EnvironmentMachineIcon kind={kind} {...props} />
  );
}
