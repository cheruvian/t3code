import { m } from "../i18n/messages";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  type ThreadId,
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ProjectScript,
  type T3ProjectFileScript,
} from "@t3tools/contracts";
import {
  type GroupedResourceLock,
  resourceOwnersForAction,
} from "@t3tools/client-runtime/state/resource-lock-grouping";

import { resourceActionKey } from "@t3tools/shared/resourceActions";
import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";

import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { projectScriptMenuLabel } from "@t3tools/shared/projectScriptsCopy";
import {
  ChevronDownIcon,
  DownloadIcon,
  PlusIcon,
  SettingsIcon,
  WrenchIcon,
  BanIcon,
} from "lucide-react";
import { projectScriptsMatch } from "@t3tools/shared/projectScripts";
import React, { useState } from "react";
import { T, useGT, useMessages, Var } from "gt-react";

import { commandForProjectScript, primaryProjectScript } from "~/projectScripts";
import { shortcutLabelForCommand } from "~/keybindings";
import { serverEnvironment } from "~/state/server";
import { readEnvironmentScope } from "~/state/session";
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
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { cn } from "~/lib/utils";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
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
  threadId?: ThreadId;
  displayMode?: "toolbar" | "panel";
  presentation?: "toolbar" | "menu";
  onRequestMenuClose?: () => void;
  environmentId: EnvironmentId;
  scripts: ReadonlyArray<ProjectScript>;
  /** IDs owned by this project. Inherited actions are runnable but not editable here. */
  editableScriptIds?: ReadonlySet<string>;
  inheritedScriptIds?: ReadonlySet<string>;
  /** Legacy import candidates used by project-settings callers. */
  fileScripts?: ReadonlyArray<T3ProjectFileScript>;
  preferredScriptId?: string | null;
  onRunScript?: ((script: ProjectScript) => void) | undefined;
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
  threadId,
  displayMode = "toolbar",
  presentation = "toolbar",
  onRequestMenuClose,
  environmentId,
  scripts,
  editableScriptIds,
  inheritedScriptIds = NO_INHERITED_SCRIPT_IDS,
  fileScripts = NO_FILE_SCRIPTS,
  preferredScriptId = null,
  onRunScript,
  onAddScript,
  onUpdateScript,
  onDeleteScript,
  onSetInheritedDisabled,
}: ProjectScriptsControlProps) {
  const gt = useGT();
  const messages = useMessages();
  const isPanel = displayMode === "panel";
  const ActionGroup = isPanel ? "div" : Group;
  const panelAnchorRef = React.useRef<HTMLDivElement | null>(null);
  const keybindings =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.keybindings ??
    DEFAULT_RESOLVED_KEYBINDINGS;
  const [actionsMenuOpen, setActionsMenuOpen] = useState({
    presentation,
    scripts: false,
    imports: false,
  });
  if (actionsMenuOpen.presentation !== presentation) {
    setActionsMenuOpen({ presentation, scripts: false, imports: false });
  }
  const [editorRequest, setEditorRequest] = useState<ProjectScriptEditorRequest | null>(null);
  const editorRequestIdRef = React.useRef(0);

  const resourceLabel = (script: ProjectScript, includeOwner = true) => {
    if (!script.resource) return script.name;
    const owners = resourceOwnersForAction(resourceLocks, script);
    const owner =
      owners.find(
        (entry) =>
          entry.project.environmentId === environmentId && entry.lock.threadId === threadId,
      ) ?? owners[0];
    if (!owner) return `Check out ${script.name}`;
    if (owners.length > 1)
      return owner.project.environmentId === environmentId && owner.lock.threadId === threadId
        ? `Release ${script.name} · Conflicting checkouts`
        : `${script.name} · Conflicting checkouts`;
    const lock = owner.lock;
    if (owner.project.environmentId !== environmentId || lock.threadId !== threadId)
      return `Take over ${script.name}${includeOwner && resourceOwnerLabels?.get(resourceActionKey(script)) ? ` · ${resourceOwnerLabels.get(resourceActionKey(script))}` : ""}`;
    if (lock.phase === "checkout") return `${script.name} · Checking out…`;
    if (lock.phase === "release") return `${script.name} · Releasing…`;
    return `Release ${script.name}`;
  };
  const resourceBusy = (script: ProjectScript) => {
    if (!script.resource) return false;
    if (!resourceActionsEnabled) return true;
    const owners = resourceOwnersForAction(resourceLocks, script);
    const own = owners.find(
      (entry) => entry.project.environmentId === environmentId && entry.lock.threadId === threadId,
    );
    const relevant = own ? [own] : owners;
    return relevant.some(({ lock }) => lock.phase === "checkout" || lock.phase === "release");
  };

  const primaryScript = (() => {
    if (preferredScriptId) {
      const preferred = scripts.find((script) => script.id === preferredScriptId);
      if (preferred) return preferred;
    }
    return primaryProjectScript(scripts);
  })();
  const importableScripts = (() => importableProjectFileScripts(fileScripts, scripts))();

  const openAddDialog = () => {
    editorRequestIdRef.current += 1;
    setEditorRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT });
  };

  const openEditDialog = (script: ProjectScript) => {
    editorRequestIdRef.current += 1;
    onRequestMenuClose?.();
    setActionsMenuOpen({ presentation, scripts: false, imports: false });
    setEditorRequest(editorRequestForScript(script, keybindings));
  };

  const openCustomizeDialog = (script: ProjectScript) => {
    onRequestMenuClose?.();
    setActionsMenuOpen({ presentation, scripts: false, imports: false });
    setEditorRequest({ ...editorRequestForScript(script, keybindings), scriptId: null });
  };

  const submitScript = (scriptId: string | null, input: NewProjectScriptInput) =>
    scriptId === null ? onAddScript(input) : onUpdateScript(scriptId, input);

  const importFileScript = async (fileScript: T3ProjectFileScript) => {
    const requestId = ++editorRequestIdRef.current;
    const payload: NewProjectScriptInput = {
      name: fileScript.name,
      command: fileScript.command,
      ...(fileScript.resource ? { resource: fileScript.resource } : {}),
      icon: fileScript.icon ?? "play",
      runOnWorktreeCreate: fileScript.runOnWorktreeCreate ?? false,
      waitForSetup: fileScript.runOnWorktreeCreate === true && fileScript.async === false,
      runOnSettle: fileScript.runOnSettle ?? false,
      stopOnSettle: fileScript.stopOnSettle ?? false,
      ...(readEnvironmentScope(environmentId, AuthSettingsWriteScope) ? { keybinding: null } : {}),
      previewUrl: fileScript.previewUrl ?? null,
      autoOpenPreview: fileScript.previewUrl ? (fileScript.autoOpenPreview ?? false) : false,
    };
    const result = await onAddScript(payload);
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;

    const message = thrownErrorMessage(squashAtomCommandFailure(result), m);
    if (requestId !== editorRequestIdRef.current) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Failed to import {name}.", { name: fileScript.name }),
          ...(message ? { description: message } : {}),
        }),
      );
      return;
    }
    setEditorRequest({
      scriptId: null,
      initial: payload,
      error: message ?? gt("Failed to import action."),
    });
  };

  const importMenuItems = importableScripts.length > 0 && (
    <>
      {scripts.length > 0 && <MenuSeparator />}
      <MenuGroup>
        <MenuGroupLabel>
          <T>
            From <Var>t3.json</Var>
          </T>
        </MenuGroupLabel>
        {importableScripts.map((fileScript) => (
          <MenuItem
            density={presentation === "menu" ? "touch" : "default"}
            key={`${fileScript.name} ${fileScript.command}`}
            onClick={() => void importFileScript(fileScript)}
          >
            <ScriptIcon icon={fileScript.icon ?? "play"} className="size-4" />
            <MenuItemLabel>{fileScript.name}</MenuItemLabel>
            <MenuShortcut>
              <DownloadIcon
                className="size-3.5"
                aria-label={gt("Import", { $context: "verb, import an action from t3.json" })}
              />
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
            disabled={!onRunScript || resourceBusy(script)}
            onClick={() => onRunScript?.(script)}
          >
            <ScriptIcon icon={script.icon} className="size-4" />
            <MenuItemLabel>
              {script.resource ? resourceLabel(script) : projectScriptMenuLabel(script, messages)}
            </MenuItemLabel>
            <span className="relative ms-auto flex h-6 min-w-6 items-center justify-end">
              {shortcutLabel && (
                <span
                  className={
                    presentation === "menu"
                      ? "ms-0 mr-7"
                      : "ms-0 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0"
                  }
                >
                  <MenuShortcut>{shortcutLabel}</MenuShortcut>
                </span>
              )}
              {editableScriptIds?.has(script.id) !== false || inherited ? (
                <span
                  className={`absolute right-0 top-1/2 size-6 -translate-y-1/2 ${presentation === "menu" ? "" : "opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-visible:opacity-100 group-focus-visible:pointer-events-auto"}`}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
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
                </span>
              ) : null}
              {inherited && onSetInheritedDisabled ? (
                <span
                  className={`absolute right-6 top-1/2 size-6 -translate-y-1/2 ${presentation === "menu" ? "" : "opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-visible:opacity-100 group-focus-visible:pointer-events-auto"}`}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
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
                </span>
              ) : null}
            </span>
          </MenuItem>
        );
      })}
      {importMenuItems}
      <MenuItem density={presentation === "menu" ? "touch" : "default"} onClick={openAddDialog}>
        <PlusIcon className="size-4" />
        <MenuItemLabel>{isPanel ? gt("Add project script") : gt("Add action")}</MenuItemLabel>
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
              disabled={!onRunScript || resourceBusy(primaryScript)}
              onClick={() => onRunScript?.(primaryScript)}
            >
              <ScriptIcon icon={primaryScript.icon} className="size-4" />
              <MenuItemLabel>
                {primaryScript.resource
                  ? resourceLabel(primaryScript)
                  : gt("Run {name}", { name: primaryScript.name })}
              </MenuItemLabel>
              <MenuShortcut>
                {inheritedScriptIds.has(primaryScript.id)
                  ? null
                  : shortcutLabelForCommand(keybindings, commandForProjectScript(primaryScript.id))}
              </MenuShortcut>
            </MenuItem>
          )}
          {scripts.length > 0 || importableScripts.length > 0 ? (
            <MenuSub
              open={actionsMenuOpen.scripts}
              onOpenChange={(open) =>
                setActionsMenuOpen({ presentation, scripts: open, imports: false })
              }
            >
              <MenuSubTrigger density="touch">
                <ScriptIcon icon="play" className="size-4" />
                <MenuItemLabel>
                  <T>Project actions</T>
                </MenuItemLabel>
              </MenuSubTrigger>
              <MenuSubPopup>{scriptItems}</MenuSubPopup>
            </MenuSub>
          ) : (
            <MenuItem
              density={presentation === "menu" ? "touch" : "default"}
              onClick={openAddDialog}
            >
              <PlusIcon className="size-4" />
              <MenuItemLabel>
                <T>Add project action…</T>
              </MenuItemLabel>
            </MenuItem>
          )}
        </>
      ) : primaryScript ? (
        <ActionGroup
          role="group"
          aria-label={gt("Project scripts")}
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
                  aria-label={
                    primaryScript.resource
                      ? resourceLabel(primaryScript)
                      : gt("Run {name}", { name: primaryScript.name })
                  }
                  // Tooltip replaces the button data-slot, so toolbar theming needs a separate hook.
                  data-toolbar-control=""
                  disabled={!onRunScript || resourceBusy(primaryScript)}
                  onClick={() => onRunScript?.(primaryScript)}
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
                  isPanel && cn("not-sr-only ml-0 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS),
                )}
              >
                {resourceLabel(primaryScript, false)}
              </span>
            </TooltipTrigger>
            <TooltipPopup side="top">
              {onRunScript
                ? primaryScript.resource
                  ? resourceLabel(primaryScript)
                  : gt("Run {name}", { name: primaryScript.name })
                : gt("Pair this client again with permission to run terminal commands.")}
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
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <ThreadDetailsControl
                        size={isPanel ? "sm" : "icon-xs"}
                        variant={isPanel ? "ghost" : "outline"}
                        part="secondary"
                        panel={isPanel}
                        aria-label={gt("Script actions")}
                        data-toolbar-control=""
                      />
                    }
                  />
                }
              >
                <ChevronDownIcon
                  className={isPanel ? THREAD_DETAILS_PANEL_CHEVRON_CLASS : "size-4"}
                />
              </TooltipTrigger>
              <TooltipPopup side="top">
                <T>Script actions</T>
              </TooltipPopup>
            </Tooltip>
            <MenuPopup
              align="end"
              {...(isPanel ? { anchor: panelAnchorRef } : {})}
              className={isPanel ? "w-(--anchor-width)" : undefined}
            >
              {scriptItems}
            </MenuPopup>
          </Menu>
        </ActionGroup>
      ) : scripts.length > 0 || importableScripts.length > 0 ? (
        // No one-click action (only a settle action, or only t3.json imports),
        // so the saved actions stay reachable through this menu.
        isPanel ? (
          <div
            role="group"
            aria-label={gt("Project actions")}
            className={THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS}
            ref={panelAnchorRef}
          >
            <ThreadDetailsControl
              size="sm"
              variant="ghost"
              part="primary"
              aria-label={gt("Project actions")}
              onClick={() => setActionsMenuOpen({ presentation, scripts: false, imports: true })}
            >
              <WrenchIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <span className={cn("min-w-0 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
                <T context="project actions menu">Actions</T>
              </span>
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
                    aria-label={gt("Choose project action")}
                  />
                }
              >
                <ChevronDownIcon className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} />
              </MenuTrigger>
              <MenuPopup align="end" anchor={panelAnchorRef} className="w-(--anchor-width)">
                {scriptItems}
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
              render={<Button size="xs" variant="outline" aria-label={gt("Project actions")} />}
            >
              <WrenchIcon className="size-3.5" />
              <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
                <T context="project actions menu">Actions</T>
              </span>
              <ChevronDownIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end">{scriptItems}</MenuPopup>
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
                aria-label={isPanel ? gt("Add project script") : gt("Add action")}
                data-toolbar-control=""
                onClick={openAddDialog}
              />
            }
          >
            <PlusIcon className="size-3.5" />
            <span
              className={cn(
                "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5",
                isPanel && cn("not-sr-only ml-0.5", THREAD_DETAILS_PANEL_LABEL_CLASS),
              )}
            >
              {isPanel ? gt("Add project script") : gt("Add action")}
            </span>
          </TooltipTrigger>
          <TooltipPopup side="top">
            {isPanel ? gt("Add project script") : gt("Add action")}
          </TooltipPopup>
        </Tooltip>
      )}

      <ProjectScriptEditorDialog
        environmentId={environmentId}
        request={editorRequest}
        scripts={scripts}
        onSubmit={submitScript}
        onDelete={(scriptId) => void onDeleteScript(scriptId)}
        onClose={() => setEditorRequest(null)}
      />
    </>
  );
}
