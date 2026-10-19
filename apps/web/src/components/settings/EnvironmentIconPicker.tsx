import {
  AuthSettingsWriteScope,
  ENVIRONMENT_MACHINE_KINDS,
  isEnvironmentMachineKind,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ServerConfig,
} from "@t3tools/contracts";

import { useProjects } from "../../state/entities";
import { EnvironmentIcon } from "../EnvironmentIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentScope } from "../../state/session";
import { ENVIRONMENT_MACHINE_KIND_LABELS, EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "../ui/menu";

export function resolveEnvironmentIconPickerLock(input: {
  readonly serverConfig: ServerConfig | null;
  readonly operateAccess: "granted" | "denied" | "pending";
}): string | null {
  if (input.serverConfig === null) {
    return "Connect to this environment to change its icon.";
  }
  if (input.serverConfig.environment.capabilities.environmentIcon !== true) {
    return "This environment's server is too old to keep an icon. Update it to choose one.";
  }
  if (input.operateAccess !== "granted") {
    return "Your session on this environment cannot change its settings.";
  }
  return null;
}

export function EnvironmentIconMenu({
  environmentId,
  serverConfig,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: ServerConfig | null;
}) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const projectId = serverConfig?.settings.environmentIconProjectId ?? null;
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const operateAccess = useEnvironmentScope(environmentId, AuthSettingsWriteScope)
    ? "granted"
    : "denied";
  const lock = resolveEnvironmentIconPickerLock({ serverConfig, operateAccess });
  const detected = serverConfig?.environment.platform.machine ?? "server";
  const resolved = resolveEnvironmentMachineKind(serverConfig);

  return (
    <MenuSub>
      <MenuSubTrigger>
        <EnvironmentIcon environmentId={environmentId} kind={resolved} />
        Icon
      </MenuSubTrigger>
      <MenuSubPopup>
        {lock !== null ? (
          <>
            <MenuItem disabled className="whitespace-normal">
              {lock}
            </MenuItem>
            <MenuSeparator />
          </>
        ) : null}
        <MenuRadioGroup
          value={projectId ? `project:${projectId}` : resolved}
          onValueChange={(next) => {
            if (lock !== null) return;
            const project = projects.find((project) => `project:${project.id}` === next);
            if (project && serverConfig?.environment.capabilities.environmentIconProject) {
              updateSettings({ environmentIconProjectId: project.id });
              return;
            }
            if (!isEnvironmentMachineKind(next)) return;
            updateSettings({
              environmentIcon: next === detected ? null : next,
              ...(serverConfig?.environment.capabilities.environmentIconProject
                ? { environmentIconProjectId: null }
                : {}),
            });
          }}
        >
          {ENVIRONMENT_MACHINE_KINDS.map((kind) => (
            <MenuRadioItem key={kind} value={kind} disabled={lock !== null}>
              <span className="flex min-w-0 items-center gap-2">
                <EnvironmentMachineIcon kind={kind} className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {ENVIRONMENT_MACHINE_KIND_LABELS[kind]}
                </span>
                {kind === detected ? (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {serverConfig?.environment.platform.machine ? "detected" : "default"}
                  </span>
                ) : null}
              </span>
            </MenuRadioItem>
          ))}
          {serverConfig?.environment.capabilities.environmentIconProject ? (
            <>
              <MenuSeparator />
              {projects.map((project) => (
                <MenuRadioItem
                  key={project.id}
                  value={`project:${project.id}`}
                  disabled={lock !== null}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <ProjectFavicon project={project} className="size-3.5 shrink-0" />
                    <span className="truncate">Use {project.title} icon</span>
                  </span>
                </MenuRadioItem>
              ))}
            </>
          ) : null}
        </MenuRadioGroup>
      </MenuSubPopup>
    </MenuSub>
  );
}
