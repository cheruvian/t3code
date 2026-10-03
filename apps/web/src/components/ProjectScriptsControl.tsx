import type { ThreadId } from "@t3tools/contracts";
import type { GroupedResourceLock } from "@t3tools/client-runtime/state/resource-lock-grouping";
import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import type {
  ProjectScript,
  ResolvedKeybindingsConfig,
  T3ProjectFileScript,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  BanIcon,
  ChevronDownIcon,
  DownloadIcon,
  PlusIcon,
  SettingsIcon,
  WrenchIcon,
} from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { projectScriptsMatch } from "@t3tools/shared/projectScripts";

import { commandForProjectScript, primaryProjectScript } from "~/projectScripts";
import { shortcutLabelForCommand } from "~/keybindings";
import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  editorRequestForScript,
  ProjectScriptEditorDialog,
  ScriptIcon,
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
  type ProjectScriptEditorRequest,
} from "./projectScriptEditor";
import { Button } from "./ui/button";
import { Group, GroupSeparator } from "./ui/group";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { cn } from "~/lib/utils";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./chat/threadDetailsPanelStyles";

export type { NewProjectScriptInput, ProjectScriptActionResult };

const NO_RESOURCE_LOCKS: readonly GroupedResourceLock[] = [];
const NO_FILE_SCRIPTS: ReadonlyArray<T3ProjectFileScript> = [];
const NO_INHERITED_SCRIPT_IDS: ReadonlySet<string> = new Set();

export function importableProjectFileScripts(
  fileScripts: ReadonlyArray<T3ProjectFileScript>,
  scripts: ReadonlyArray<ProjectScript>,
): ReadonlyArray<T3ProjectFileScript> {
  return fileScripts.filter(
    (fileScript) => !scripts.some((script) => projectScriptsMatch(script, fileScript)),
  );
}

interface ProjectScriptsControlProps {
  resourceActionsEnabled?: boolean;
  resourceLocks?: readonly GroupedResourceLock[];
  resourceOwnerLabels?: ReadonlyMap<string, string>;
  environmentId?: string;
  threadId?: ThreadId;
  displayMode?: "toolbar" | "panel";
  presentation?: "toolbar" | "menu";
  onRequestMenuClose?: () => void;
  scripts: ReadonlyArray<ProjectScript>;
  /** IDs owned by this project. Inherited actions are runnable but not editable here. */
  editableScriptIds?: ReadonlySet<string>;
  inheritedScriptIds?: ReadonlySet<string>;
  /** Legacy import candidates used by project-settings callers. */
  fileScripts?: ReadonlyArray<T3ProjectFileScript>;
  keybindings: ResolvedKeybindingsConfig;
  preferredScriptId?: string | null;
  onRunScript: (script: ProjectScript) => void;
  onAddScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
  onSetInheritedDisabled?: (scriptId: string, disabled: boolean) => void;
}

export default function ProjectScriptsControl({
  resourceActionsEnabled = true,
  resourceLocks = NO_RESOURCE_LOCKS,
  resourceOwnerLabels,
  environmentId,
  threadId,
  displayMode = "toolbar",
  presentation = "toolbar",
  onRequestMenuClose,
  scripts,
  editableScriptIds,
  inheritedScriptIds = NO_INHERITED_SCRIPT_IDS,
  fileScripts = NO_FILE_SCRIPTS,
  keybindings,
  preferredScriptId = null,
  onRunScript,
  onAddScript,
  onUpdateScript,
  onDeleteScript,
  onSetInheritedDisabled,
}: ProjectScriptsControlProps) {
  const isPanel = displayMode === "panel";
  const ActionGroup = isPanel ? "div" : Group;
  const panelAnchorRef = React.useRef<HTMLDivElement | null>(null);
  const [actionsMenuOpen, setActionsMenuOpen] = useState({
    presentation,
    scripts: false,
    imports: false,
  });
  if (actionsMenuOpen.presentation !== presentation) {
    setActionsMenuOpen({ presentation, scripts: false, imports: false });
  }
  const [editorRequest, setEditorRequest] = useState<ProjectScriptEditorRequest | null>(null);

  const resourceLabel = (script: ProjectScript, includeOwner = true) => {
    if (!script.resource) return script.name;
    const owners = resourceLocks.filter((entry) => entry.lock.script.id === script.id);
    const owner =
      owners.find(
        (entry) =>
          entry.project.environmentId === environmentId && entry.lock.threadId === threadId,
      ) ?? owners[0];
    if (!owner) return `Check out ${script.name}`;
    if (owners.length > 1 && owner.lock.threadId !== threadId)
      return `${script.name} · Conflicting checkouts`;
    const lock = owner.lock;
    if (owner.project.environmentId !== environmentId || lock.threadId !== threadId)
      return `Take over ${script.name}${includeOwner && resourceOwnerLabels?.get(script.id) ? ` · ${resourceOwnerLabels.get(script.id)}` : ""}`;
    if (lock.phase === "checkout") return `${script.name} · Checking out…`;
    if (lock.phase === "release") return `${script.name} · Releasing…`;
    return `Release ${script.name}`;
  };
  const resourceBusy = (script: ProjectScript) =>
    (Boolean(script.resource) && !resourceActionsEnabled) ||
    resourceLocks.some(
      (lock) =>
        lock.lock.script.id === script.id &&
        (lock.lock.phase === "checkout" || lock.lock.phase === "release"),
    );

  const primaryScript = useMemo(() => {
    if (preferredScriptId) {
      const preferred = scripts.find((script) => script.id === preferredScriptId);
      if (preferred) return preferred;
    }
    return primaryProjectScript(scripts);
  }, [preferredScriptId, scripts]);
  const importableScripts = useMemo(
    () => importableProjectFileScripts(fileScripts, scripts),
    [fileScripts, scripts],
  );

  const openAddDialog = () => {
    setEditorRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT });
  };

  const openEditDialog = (script: ProjectScript) => {
    onRequestMenuClose?.();
    setActionsMenuOpen({ presentation, scripts: false, imports: false });
    setEditorRequest(editorRequestForScript(script, keybindings));
  };

  const openCustomizeDialog = (script: ProjectScript) => {
    onRequestMenuClose?.();
    setActionsMenuOpen({ presentation, scripts: false, imports: false });
    setEditorRequest({ ...editorRequestForScript(script, keybindings), scriptId: null });
  };

  const submitScript = useCallback(
    (scriptId: string | null, input: NewProjectScriptInput) =>
      scriptId === null ? onAddScript(input) : onUpdateScript(scriptId, input),
    [onAddScript, onUpdateScript],
  );

  const importFileScript = async (fileScript: T3ProjectFileScript) => {
    const payload: NewProjectScriptInput = {
      name: fileScript.name,
      command: fileScript.command,
      ...(fileScript.resource ? { resource: fileScript.resource } : {}),
      icon: fileScript.icon ?? "play",
      runOnWorktreeCreate: fileScript.runOnWorktreeCreate ?? false,
      waitForSetup: fileScript.runOnWorktreeCreate === true && fileScript.async === false,
      keybinding: null,
      previewUrl: fileScript.previewUrl ?? null,
      autoOpenPreview: fileScript.previewUrl ? (fileScript.autoOpenPreview ?? false) : false,
    };
    const result = await onAddScript(payload);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      // Surface the failure through the regular add dialog, prefilled so the
      // user can adjust and retry.
      const error = squashAtomCommandFailure(result);
      setEditorRequest({
        scriptId: null,
        initial: payload,
        error: error instanceof Error ? error.message : "Failed to import action.",
      });
    }
  };

  const importMenuItems = importableScripts.length > 0 && (
    <>
      {primaryScript && <MenuSeparator />}
      <MenuGroup>
        <MenuGroupLabel>From t3.json</MenuGroupLabel>
        {importableScripts.map((fileScript) => (
          <MenuItem
            density={presentation === "menu" ? "touch" : "default"}
            key={`${fileScript.name} ${fileScript.command}`}
            onClick={() => void importFileScript(fileScript)}
          >
            <ScriptIcon icon={fileScript.icon ?? "play"} className="size-4" />
            <MenuItemLabel>{fileScript.name}</MenuItemLabel>
            <MenuShortcut>
              <DownloadIcon className="size-3.5" aria-label="Import" />
            </MenuShortcut>
          </MenuItem>
        ))}
      </MenuGroup>
    </>
  );

  const scriptItems = (
    <>
      {scripts.map((script) => {
        const inherited = inheritedScriptIds.has(script.id);
        const shortcutLabel = inherited
          ? null
          : shortcutLabelForCommand(keybindings, commandForProjectScript(script.id));
        return (
          <MenuItem
            density={presentation === "menu" ? "touch" : "default"}
            key={script.id}
            className="group"
            disabled={resourceBusy(script)}
            onClick={() => onRunScript(script)}
          >
            <ScriptIcon icon={script.icon} className="size-4" />
            <MenuItemLabel className="truncate">
              {script.runOnWorktreeCreate ? `${script.name} (setup)` : resourceLabel(script)}
            </MenuItemLabel>
            <span className="relative ms-auto flex h-6 min-w-6 items-center justify-end">
              {shortcutLabel && (
                <MenuShortcut
                  className={
                    presentation === "menu"
                      ? "ms-0 mr-7"
                      : "ms-0 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0"
                  }
                >
                  {shortcutLabel}
                </MenuShortcut>
              )}
              {editableScriptIds?.has(script.id) !== false || inherited ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className={`absolute right-0 top-1/2 size-6 -translate-y-1/2 ${presentation === "menu" ? "" : "opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-visible:opacity-100 group-focus-visible:pointer-events-auto"}`}
                  aria-label={`${inherited ? "Customize" : "Edit"} ${script.name}`}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (inherited) openCustomizeDialog(script);
                    else openEditDialog(script);
                  }}
                >
                  <SettingsIcon className="size-3.5" />
                </Button>
              ) : null}
              {inherited && onSetInheritedDisabled ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className={`absolute right-6 top-1/2 size-6 -translate-y-1/2 ${presentation === "menu" ? "" : "opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-visible:opacity-100 group-focus-visible:pointer-events-auto"}`}
                  aria-label={`Disable ${script.name}`}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onSetInheritedDisabled(script.id, true);
                  }}
                >
                  <BanIcon className="size-3.5" />
                </Button>
              ) : null}
            </span>
          </MenuItem>
        );
      })}
      {importMenuItems}
      <MenuItem density={presentation === "menu" ? "touch" : "default"} onClick={openAddDialog}>
        <PlusIcon className="size-4" />
        <MenuItemLabel>{isPanel ? "Add project script" : "Add action"}</MenuItemLabel>
      </MenuItem>
    </>
  );

  return (
    <>
      {presentation === "menu" ? (
        <>
          {primaryScript && (
            <MenuItem
              density={presentation === "menu" ? "touch" : "default"}
              disabled={resourceBusy(primaryScript)}
              onClick={() => onRunScript(primaryScript)}
            >
              <ScriptIcon icon={primaryScript.icon} className="size-4" />
              <MenuItemLabel className="truncate">
                {primaryScript.resource ? "" : "Run "}
                {resourceLabel(primaryScript)}
              </MenuItemLabel>
              <MenuShortcut>
                {inheritedScriptIds.has(primaryScript.id)
                  ? null
                  : shortcutLabelForCommand(keybindings, commandForProjectScript(primaryScript.id))}
              </MenuShortcut>
            </MenuItem>
          )}
          {primaryScript || importableScripts.length > 0 ? (
            <MenuSub
              open={actionsMenuOpen.scripts}
              onOpenChange={(open) =>
                setActionsMenuOpen({ presentation, scripts: open, imports: false })
              }
            >
              <MenuSubTrigger density="touch">
                <ScriptIcon icon="play" className="size-4" />
                <MenuItemLabel>Project actions</MenuItemLabel>
              </MenuSubTrigger>
              <MenuSubPopup>{scriptItems}</MenuSubPopup>
            </MenuSub>
          ) : (
            <MenuItem
              density={presentation === "menu" ? "touch" : "default"}
              onClick={openAddDialog}
            >
              <PlusIcon className="size-4" />
              <MenuItemLabel>Add project action…</MenuItemLabel>
            </MenuItem>
          )}
        </>
      ) : primaryScript ? (
        <ActionGroup
          role="group"
          aria-label="Project scripts"
          {...(isPanel
            ? { className: THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS, ref: panelAnchorRef }
            : {})}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="xs"
                  variant={isPanel ? "ghost" : "outline"}
                  part="primary"
                  panel={isPanel}
                  className={isPanel ? undefined : "w-7 sm:w-6 @3xl/header-actions:w-auto!"}
                  aria-label={`${primaryScript.resource ? "" : "Run "}${resourceLabel(primaryScript)}`}
                  // The tooltip wrapper replaces data-slot="button", so themed
                  // toolbar styling needs its own hook.
                  data-toolbar-control=""
                  disabled={resourceBusy(primaryScript)}
                  onClick={() => onRunScript(primaryScript)}
                />
              }
            >
              <ScriptIcon
                icon={primaryScript.icon}
                {...(isPanel ? { className: THREAD_DETAILS_PANEL_ICON_CLASS } : {})}
              />
              <span
                className={cn(
                  "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5",
                  isPanel && "not-sr-only ml-0 truncate",
                )}
              >
                {resourceLabel(primaryScript, false)}
              </span>
            </TooltipTrigger>
            <TooltipPopup side="top">
              {primaryScript.resource ? "" : "Run "}
              {resourceLabel(primaryScript)}
            </TooltipPopup>
          </Tooltip>
          {isPanel ? (
            <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
          ) : (
            <GroupSeparator className="hidden @3xl/header-actions:block" />
          )}
          <Menu
            open={actionsMenuOpen.scripts}
            onOpenChange={(open) =>
              setActionsMenuOpen({ presentation, scripts: open, imports: false })
            }
          >
            <MenuTrigger
              render={
                <ThreadDetailsControl
                  size={isPanel ? "sm" : "icon-xs"}
                  variant={isPanel ? "ghost" : "outline"}
                  part="secondary"
                  panel={isPanel}
                  aria-label="Script actions"
                />
              }
            >
              <ChevronDownIcon
                className={isPanel ? THREAD_DETAILS_PANEL_CHEVRON_CLASS : "size-4"}
              />
            </MenuTrigger>
            <MenuPopup
              align="end"
              {...(isPanel ? { anchor: panelAnchorRef } : {})}
              className={isPanel ? "w-(--anchor-width)" : undefined}
            >
              {scriptItems}
            </MenuPopup>
          </Menu>
        </ActionGroup>
      ) : importableScripts.length > 0 ? (
        isPanel ? (
          <div
            role="group"
            aria-label="Project actions"
            className={THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS}
            ref={panelAnchorRef}
          >
            <ThreadDetailsControl
              size="sm"
              variant="ghost"
              part="primary"
              aria-label="Project actions"
              onClick={() => setActionsMenuOpen({ presentation, scripts: false, imports: true })}
            >
              <WrenchIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <span className="min-w-0 truncate">Actions</span>
            </ThreadDetailsControl>
            <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
            <Menu
              highlightItemOnHover={false}
              open={actionsMenuOpen.imports}
              onOpenChange={(open) =>
                setActionsMenuOpen({ presentation, scripts: false, imports: open })
              }
            >
              <MenuTrigger
                render={
                  <ThreadDetailsControl
                    size="sm"
                    variant="ghost"
                    part="secondary"
                    aria-label="Choose project action"
                  />
                }
              >
                <ChevronDownIcon className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} />
              </MenuTrigger>
              <MenuPopup align="end" anchor={panelAnchorRef} className="w-(--anchor-width)">
                {importMenuItems}
                <MenuItem onClick={openAddDialog}>
                  <PlusIcon className="size-4" />
                  Add action
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        ) : (
          <Menu
            highlightItemOnHover={false}
            open={actionsMenuOpen.imports}
            onOpenChange={(open) =>
              setActionsMenuOpen({ presentation, scripts: false, imports: open })
            }
          >
            <MenuTrigger
              render={<Button size="xs" variant="outline" aria-label="Project actions" />}
            >
              <WrenchIcon className="size-3.5" />
              <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
                Actions
              </span>
              <ChevronDownIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end">
              {importMenuItems}
              <MenuItem onClick={openAddDialog}>
                <PlusIcon className="size-4" />
                Add action
              </MenuItem>
            </MenuPopup>
          </Menu>
        )
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <ThreadDetailsControl
                size="xs"
                variant={isPanel ? "ghost" : "outline"}
                part="row"
                panel={isPanel}
                className={isPanel ? undefined : "w-7 sm:w-6 @3xl/header-actions:w-auto!"}
                aria-label={isPanel ? "Add project script" : "Add action"}
                // The tooltip wrapper replaces data-slot="button", so themed
                // toolbar styling needs its own hook.
                data-toolbar-control=""
                onClick={openAddDialog}
              />
            }
          >
            <PlusIcon className="size-3.5" />
            <span
              className={cn(
                "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5",
                isPanel && "not-sr-only ml-0.5",
              )}
            >
              {isPanel ? "Add project script" : "Add action"}
            </span>
          </TooltipTrigger>
          <TooltipPopup side="top">{isPanel ? "Add project script" : "Add action"}</TooltipPopup>
        </Tooltip>
      )}

      <ProjectScriptEditorDialog
        request={editorRequest}
        scripts={scripts}
        onSubmit={submitScript}
        onDelete={(scriptId) => void onDeleteScript(scriptId)}
        onClose={() => setEditorRequest(null)}
      />
    </>
  );
}
