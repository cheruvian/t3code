import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";
import { useRightPanelStore } from "../rightPanelStore";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type ContextMenuItem,
  type EnvironmentId,
  type VcsRef,
  type ThreadId,
} from "@t3tools/contracts";
import { ChevronDownIcon, GitBranchIcon } from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useImperativeHandle,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
  type MouseEvent as ReactMouseEvent,
  type Ref,
} from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { readLocalApi } from "../localApi";
import { useOpenPrLink } from "../lib/openPullRequestLink";
import { usePaginatedBranches } from "../state/queries";
import { useProject, useThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { cn } from "../lib/utils";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./chat/threadDetailsPanelStyles";
import { ThreadDetailsPrRows } from "./chat/ThreadDetailsPrRows";
import { parsePullRequestReference } from "../pullRequestReference";
import { getSourceControlPresentation } from "../sourceControlPresentation";
import { useComposerMenuProps } from "./chat/composerEventScope";
import {
  deriveLocalBranchNameFromRemoteRef,
  resolveBranchTriggerLabel,
  resolveBranchToolbarPrBranch,
  resolveBranchSelectionTarget,
  resolveBranchToolbarValue,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
  sanitizeNewRefName,
  shouldIncludeBranchPickerItem,
} from "./BranchToolbar.logic";
import {
  ThreadPullRequestBadgeControl,
  prStatusIndicator,
  resolveThreadPullRequestBadge,
  useLinkedThreadPullRequest,
} from "./ThreadStatusIndicators";

import { ComboboxItem, ComboboxTrigger } from "./ui/combobox";
import { ComposerControl } from "./chat/ComposerControl";
import { MiddleTruncate } from "./ui/middle-truncate";
import { BranchPicker, BranchPickerRefItem } from "./BranchPicker";
import { stackedThreadToast, toastManager } from "./ui/toast";

export interface BranchToolbarBranchSelectorHandle {
  open: () => void;
}

interface BranchToolbarBranchSelectorProps {
  forceNewWorktree?: boolean;
  ref?: Ref<BranchToolbarBranchSelectorHandle>;
  className?: string;
  displayMode?: "toolbar" | "panel";
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId?: DraftId;
  envLocked: boolean;
  effectiveEnvModeOverride?: "local" | "worktree";
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (refName: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
}

export function resolveBranchPickerRefTarget(input: {
  isOpen: boolean;
  environmentId: EnvironmentId;
  cwd: string | null;
  query: string;
}) {
  if (!input.isOpen) {
    return { environmentId: null, cwd: null, query: null };
  }
  return {
    environmentId: input.environmentId,
    cwd: input.cwd,
    query: input.query,
  };
}

export function resolveWorktreeBaseBranchCandidate(input: {
  isOpen: boolean;
  isInitialLoadPending: boolean;
  defaultBranchName: string | null;
  currentGitBranch: string | null;
}): string | null {
  if (!input.isOpen) {
    return input.currentGitBranch;
  }
  if (input.isInitialLoadPending) {
    return null;
  }
  return input.defaultBranchName ?? input.currentGitBranch;
}

export interface ImplicitWorktreeBaseBranch {
  readonly scopeKey: string;
  readonly branch: string;
}

export function resolveWorktreeBaseBranchLifecycle(input: {
  enabled: boolean;
  scopeKey: string | null;
  activeThreadBranch: string | null;
  candidate: string | null;
  preferredBranch: string | null;
  implicitBranch: ImplicitWorktreeBaseBranch | null;
}): {
  branchToSet: string | null;
  implicitBranch: ImplicitWorktreeBaseBranch | null;
} {
  if (!input.enabled || input.scopeKey === null) {
    return { branchToSet: null, implicitBranch: null };
  }

  const sameScopeImplicitBranch =
    input.implicitBranch?.scopeKey === input.scopeKey ? input.implicitBranch : null;
  if (input.activeThreadBranch === null) {
    if (input.candidate === null) {
      return { branchToSet: null, implicitBranch: sameScopeImplicitBranch };
    }
    return {
      branchToSet: input.candidate,
      implicitBranch: { scopeKey: input.scopeKey, branch: input.candidate },
    };
  }

  if (sameScopeImplicitBranch?.branch !== input.activeThreadBranch) {
    return { branchToSet: null, implicitBranch: null };
  }
  if (input.preferredBranch === null || input.preferredBranch === input.activeThreadBranch) {
    return { branchToSet: null, implicitBranch: sameScopeImplicitBranch };
  }
  return {
    branchToSet: input.preferredBranch,
    implicitBranch: { scopeKey: input.scopeKey, branch: input.preferredBranch },
  };
}

function toBranchActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

export function BranchToolbarBranchSelector({
  forceNewWorktree = false,
  ref,
  className,
  displayMode = "toolbar",
  environmentId,
  threadId,
  draftId,
  envLocked,
  effectiveEnvModeOverride,
  activeThreadBranchOverride,
  onActiveThreadBranchOverrideChange,
  startFromOrigin,
  onStartFromOriginChange,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
}: BranchToolbarBranchSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const canWriteSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const canOperateThread = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, "thread session stop");
  const updateThreadMetadata = useAtomCommand(
    threadEnvironment.updateMetadata,
    "thread metadata update",
  );
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, {
    reportFailure: false,
  });
  const createRefMutation = useAtomCommand(vcsEnvironment.createRef, {
    reportFailure: false,
  });
  // ---------------------------------------------------------------------------
  // Thread / project state (pushed down from parent to colocate with mutation)
  // ---------------------------------------------------------------------------
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const serverThread = useThreadShell(threadRef);
  const serverSession = serverThread?.runtime ?? null;
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : store.getDraftThreadByRef(threadRef),
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);

  const activeProjectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const activeProject = useProject(activeProjectRef);

  const activeThreadId = serverThread?.id ?? (draftThread ? threadId : undefined);
  const activeThreadBranch =
    activeThreadBranchOverride !== undefined
      ? activeThreadBranchOverride
      : (serverThread?.branch ?? draftThread?.branch ?? null);
  const activeWorktreePath = forceNewWorktree
    ? null
    : (serverThread?.worktreePath ?? draftThread?.worktreePath ?? null);
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const branchCwd = activeWorktreePath ?? activeProjectCwd;
  const hasServerThread = serverThread !== null;
  const canUpdateThreadBranch = !hasServerThread || canOperateThread;
  const canChangeThreadBranch = canWriteSourceControl && canUpdateThreadBranch;
  const effectiveEnvMode =
    effectiveEnvModeOverride ??
    resolveEffectiveEnvMode({
      activeWorktreePath,
      hasServerThread,
      draftThreadEnvMode: draftThread?.envMode,
    });

  // ---------------------------------------------------------------------------
  // Thread branch mutation (colocated — only this component calls it)
  // ---------------------------------------------------------------------------
  const setThreadBranch = useCallback(
    (branch: string | null, worktreePath: string | null, automatic = false) => {
      if (
        !activeThreadId ||
        !activeProject ||
        (hasServerThread && !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
      )
        return;
      if (serverSession && worktreePath !== activeWorktreePath) {
        void stopThreadSession({
          environmentId,
          input: { threadId: activeThreadId },
        });
      }
      if (hasServerThread) {
        void updateThreadMetadata({
          environmentId,
          input: {
            threadId: activeThreadId,
            branch,
            worktreePath,
          },
        });
      }
      if (hasServerThread) {
        onActiveThreadBranchOverrideChange?.(branch);
        return;
      }
      const nextDraftEnvMode = resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: worktreePath,
        currentWorktreePath: activeWorktreePath,
        effectiveEnvMode,
      });
      setDraftThreadContext(draftId ?? threadRef, {
        branch,
        worktreePath,
        envMode: nextDraftEnvMode,
        environmentSelection: automatic ? (draftThread?.environmentSelection ?? "auto") : "manual",
        projectRef: scopeProjectRef(environmentId, activeProject.id),
      });
    },
    [
      activeThreadId,
      activeProject,
      serverSession,
      activeWorktreePath,
      hasServerThread,
      onActiveThreadBranchOverrideChange,
      setDraftThreadContext,
      draftId,
      threadRef,
      environmentId,
      effectiveEnvMode,
      draftThread?.environmentSelection,
      stopThreadSession,
      updateThreadMetadata,
    ],
  );

  // ---------------------------------------------------------------------------
  // Git ref queries
  // ---------------------------------------------------------------------------
  const [isBranchMenuOpen, setIsBranchMenuOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const deferredBranchQuery = useDeferredValue(branchQuery);

  const branchStatusQuery = useEnvironmentQuery(
    branchCwd === null
      ? null
      : vcsEnvironment.remoteStatus({
          environmentId,
          input: { cwd: branchCwd },
        }),
  );
  const trimmedBranchQuery = branchQuery.trim();
  const deferredTrimmedBranchQuery = deferredBranchQuery.trim();
  // The server filters refs by substring, so it has to be given the sanitized
  // name as well: querying the raw "new branch" drops an existing new-branch
  // from the response entirely, which would defeat the collision check below.
  // Ref names cannot contain an ASCII space, so sanitizing loses no matches.
  const branchRefQuery = sanitizeNewRefName(deferredTrimmedBranchQuery);
  const branchRefTarget = useMemo(
    () =>
      resolveBranchPickerRefTarget({
        isOpen: isBranchMenuOpen,
        environmentId,
        cwd: branchCwd,
        query: branchRefQuery,
      }),
    [branchCwd, branchRefQuery, environmentId, isBranchMenuOpen],
  );
  const branchRefState = usePaginatedBranches(branchRefTarget);
  const refs = branchRefState.refs;
  const branchRefScopeKey = useMemo(
    () => (branchCwd === null ? null : JSON.stringify([environmentId, branchCwd.trim()])),
    [branchCwd, environmentId],
  );
  const [cachedBranchClassification, setCachedBranchClassification] = useState<{
    scopeKey: string;
    isRemoteByName: ReadonlyMap<string, boolean>;
  } | null>(null);
  useEffect(() => {
    if (!isBranchMenuOpen || branchRefScopeKey === null || refs.length === 0) {
      return;
    }
    setCachedBranchClassification((current) => {
      const isSameScope = current?.scopeKey === branchRefScopeKey;
      const isRemoteByName = new Map(isSameScope ? current.isRemoteByName : []);
      let changed = !isSameScope;
      for (const refName of refs) {
        const isRemote = refName.isRemote === true;
        if (isRemoteByName.get(refName.name) !== isRemote) {
          isRemoteByName.set(refName.name, isRemote);
          changed = true;
        }
      }
      return changed ? { scopeKey: branchRefScopeKey, isRemoteByName } : current;
    });
  }, [branchRefScopeKey, isBranchMenuOpen, refs]);
  const hasNextPage =
    branchRefState.data?.nextCursor !== null && branchRefState.data?.nextCursor !== undefined;
  const isFetchingNextPage = branchRefState.isFetchingNextPage;
  const isInitialBranchesLoadPending = branchRefState.isPending && branchRefState.data === null;
  const currentGitBranch =
    branchStatusQuery.data?.refName ?? refs.find((refName) => refName.current)?.name ?? null;
  const sourceControlPresentation = useMemo(
    () => getSourceControlPresentation(branchStatusQuery.data?.sourceControlProvider),
    [branchStatusQuery.data?.sourceControlProvider],
  );
  const SourceControlIcon = sourceControlPresentation.Icon;
  const canonicalActiveBranch = resolveBranchToolbarValue({
    envMode: effectiveEnvMode,
    activeWorktreePath,
    activeThreadBranch,
    currentGitBranch,
  });
  const branchNames = useMemo(() => refs.map((refName) => refName.name), [refs]);
  const branchByName = useMemo(
    () => new Map(refs.map((refName) => [refName.name, refName] as const)),
    [refs],
  );
  const normalizedDeferredBranchQuery = deferredTrimmedBranchQuery.toLowerCase();
  const prReference = parsePullRequestReference(trimmedBranchQuery);
  const isSelectingWorktreeBase =
    effectiveEnvMode === "worktree" && !envLocked && !activeWorktreePath;
  const checkoutPullRequestItemValue =
    canChangeThreadBranch && prReference && onCheckoutPullRequestRequest
      ? `__checkout_pull_request__:${prReference}`
      : null;
  const canCreateBranch =
    canChangeThreadBranch && !isSelectingWorktreeBase && trimmedBranchQuery.length > 0;
  // The ref is created under its sanitized name, so the collision check has to
  // use that name too. Matching on the raw query would offer to create a ref
  // that already exists whenever sanitizing changes the name.
  const newRefName = sanitizeNewRefName(trimmedBranchQuery);
  const hasExactBranchMatch = branchByName.has(newRefName);
  const createBranchItemValue = canCreateBranch
    ? `__create_new_branch__:${trimmedBranchQuery}`
    : null;
  const branchPickerItems = useMemo(() => {
    const items = [...branchNames];
    if (createBranchItemValue && !hasExactBranchMatch) {
      items.push(createBranchItemValue);
    }
    if (checkoutPullRequestItemValue) {
      items.unshift(checkoutPullRequestItemValue);
    }
    return items;
  }, [branchNames, checkoutPullRequestItemValue, createBranchItemValue, hasExactBranchMatch]);
  const filteredBranchPickerItems = useMemo(
    () =>
      normalizedDeferredBranchQuery.length === 0
        ? branchPickerItems
        : branchPickerItems.filter((itemValue) =>
            shouldIncludeBranchPickerItem({
              itemValue,
              normalizedQuery: normalizedDeferredBranchQuery,
              createBranchItemValue,
              checkoutPullRequestItemValue,
            }),
          ),
    [
      branchPickerItems,
      checkoutPullRequestItemValue,
      createBranchItemValue,
      normalizedDeferredBranchQuery,
    ],
  );
  const [resolvedActiveBranch, setOptimisticBranch] = useOptimistic(
    canonicalActiveBranch,
    (_currentBranch: string | null, optimisticBranch: string | null) => optimisticBranch,
  );
  const listedActiveBranch =
    resolvedActiveBranch === null ? null : (branchByName.get(resolvedActiveBranch) ?? null);
  const resolvedActiveBranchIsRemote =
    resolvedActiveBranch === null
      ? null
      : branchStatusQuery.data?.refName === resolvedActiveBranch
        ? false
        : listedActiveBranch !== null
          ? listedActiveBranch.isRemote === true
          : cachedBranchClassification?.scopeKey === branchRefScopeKey
            ? (cachedBranchClassification.isRemoteByName.get(resolvedActiveBranch) ?? null)
            : null;
  const [isBranchActionPending, startBranchActionTransition] = useTransition();
  const totalBranchCount = branchRefState.data?.totalCount ?? 0;
  const branchStatusText = isInitialBranchesLoadPending
    ? "Loading refs..."
    : isFetchingNextPage
      ? "Loading more refs..."
      : hasNextPage
        ? `Showing ${refs.length} of ${totalBranchCount} refs`
        : null;

  // ---------------------------------------------------------------------------
  // Branch actions
  // ---------------------------------------------------------------------------
  const copyBranchName = useCallback((branchName: string) => {
    void writeTextToClipboard(branchName, "branch name").then(
      (didCopy) => {
        if (!didCopy) return;
        toastManager.add({
          type: "success",
          title: "Branch name copied",
          description: branchName,
        });
      },
      (error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to copy branch name",
            description: toBranchActionErrorMessage(error),
          }),
        );
      },
    );
  }, []);

  const handleBranchContextMenu = useCallback(
    (event: ReactMouseEvent, branchName: string | null) => {
      if (!branchName) return;
      const api = readLocalApi();
      if (!api) return;
      event.preventDefault();
      event.stopPropagation();
      const items: ContextMenuItem<"copy-branch-name">[] = [
        { id: "copy-branch-name", label: "Copy branch name", icon: "copy" },
      ];
      void api.contextMenu.show(items, { x: event.clientX, y: event.clientY }).then((action) => {
        if (action === "copy-branch-name") copyBranchName(branchName);
      });
    },
    [copyBranchName],
  );

  const runBranchAction = (action: () => Promise<void>) => {
    if (
      !readEnvironmentScope(environmentId, AuthSourceControlWriteScope) ||
      (hasServerThread && !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
    ) {
      // The menu already closed when the item was chosen; explain the no-op.
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Action unavailable",
          description: "This connection cannot change the thread's branch.",
        }),
      );
      return;
    }
    startBranchActionTransition(async () => {
      await action();
      branchStatusQuery.refresh();
    });
  };

  const selectBranch = (refName: VcsRef) => {
    if (!canUpdateThreadBranch || !branchCwd || !activeProjectCwd || isBranchActionPending) return;

    if (isSelectingWorktreeBase) {
      implicitWorktreeBaseBranchRef.current = null;
      setThreadBranch(refName.name, null);
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    const selectionTarget = resolveBranchSelectionTarget({
      activeProjectCwd,
      activeWorktreePath,
      refName,
    });

    if (selectionTarget.reuseExistingWorktree) {
      setThreadBranch(refName.name, selectionTarget.nextWorktreePath);
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    const selectedBranchName = refName.isRemote
      ? deriveLocalBranchNameFromRemoteRef(refName.name)
      : refName.name;

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      const previousBranch = resolvedActiveBranch;
      setOptimisticBranch(selectedBranchName);
      const checkoutResult = await switchRef({
        environmentId,
        input: {
          cwd: selectionTarget.checkoutCwd,
          refName: refName.name,
        },
      });
      if (checkoutResult._tag === "Success") {
        const nextBranchName = refName.isRemote
          ? (checkoutResult.value.refName ?? selectedBranchName)
          : selectedBranchName;
        setOptimisticBranch(nextBranchName);
        setThreadBranch(nextBranchName, selectionTarget.nextWorktreePath);
        return;
      }
      setOptimisticBranch(previousBranch);
      if (!isAtomCommandInterrupted(checkoutResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to switch ref.",
            description: toBranchActionErrorMessage(squashAtomCommandFailure(checkoutResult)),
          }),
        );
      }
    });
  };

  const createRef = (rawName: string) => {
    if (!canChangeThreadBranch) return;
    const name = sanitizeNewRefName(rawName);
    if (!branchCwd || !name || isBranchActionPending) return;

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      const previousBranch = resolvedActiveBranch;
      setOptimisticBranch(name);
      const createBranchResult = await createRefMutation({
        environmentId,
        input: {
          cwd: branchCwd,
          refName: name,
          switchRef: true,
        },
      });
      if (createBranchResult._tag === "Success") {
        setOptimisticBranch(createBranchResult.value.refName);
        setThreadBranch(createBranchResult.value.refName, activeWorktreePath);
        return;
      }
      setOptimisticBranch(previousBranch);
      if (!isAtomCommandInterrupted(createBranchResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to create and switch ref.",
            description: toBranchActionErrorMessage(squashAtomCommandFailure(createBranchResult)),
          }),
        );
      }
    });
  };

  // Default the worktree base to the repo default branch (origin/HEAD), only
  // falling back to the checked-out branch when no default is known.
  const defaultBranchName = useMemo(
    () => refs.find((refName) => refName.isDefault)?.name ?? null,
    [refs],
  );
  const worktreeBaseBranchCandidate = resolveWorktreeBaseBranchCandidate({
    isOpen: isBranchMenuOpen,
    isInitialLoadPending: isInitialBranchesLoadPending,
    defaultBranchName,
    currentGitBranch,
  });
  const implicitWorktreeBaseBranchRef = useRef<ImplicitWorktreeBaseBranch | null>(null);

  useEffect(() => {
    const resolution = resolveWorktreeBaseBranchLifecycle({
      enabled: effectiveEnvMode === "worktree" && activeWorktreePath === null,
      scopeKey: branchRefScopeKey,
      activeThreadBranch,
      candidate: worktreeBaseBranchCandidate,
      preferredBranch: isBranchMenuOpen && !isInitialBranchesLoadPending ? defaultBranchName : null,
      implicitBranch: implicitWorktreeBaseBranchRef.current,
    });
    implicitWorktreeBaseBranchRef.current = resolution.implicitBranch;
    if (resolution.branchToSet !== null) {
      setThreadBranch(resolution.branchToSet, null, true);
    }
  }, [
    activeThreadBranch,
    activeWorktreePath,
    branchRefScopeKey,
    defaultBranchName,
    effectiveEnvMode,
    isBranchMenuOpen,
    isInitialBranchesLoadPending,
    setThreadBranch,
    worktreeBaseBranchCandidate,
  ]);

  // ---------------------------------------------------------------------------
  // Combobox / list plumbing
  // ---------------------------------------------------------------------------
  const handleOpenChange = useCallback((open: boolean) => {
    setIsBranchMenuOpen(open);
    if (!open) {
      setBranchQuery("");
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      open: () => {
        if (isInitialBranchesLoadPending || isBranchActionPending) return;
        handleOpenChange(true);
      },
    }),
    [handleOpenChange, isBranchActionPending, isInitialBranchesLoadPending],
  );

  const triggerLabel = resolveBranchTriggerLabel({
    activeWorktreePath,
    effectiveEnvMode,
    resolvedActiveBranch,
    resolvedActiveBranchIsRemote,
    startFromOrigin,
  });

  // Branch status is the fallback when this thread has no linked pull requests.
  const branchPrBranch = resolveBranchToolbarPrBranch({
    activeThreadBranch,
    resolvedActiveBranch,
  });
  const branchPr =
    branchPrBranch !== null && branchStatusQuery.data?.refName === branchPrBranch
      ? (branchStatusQuery.data.pr ?? null)
      : null;
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(environmentId);
  const linkedStatus = useLinkedThreadPullRequest(
    environmentId,
    serverThread?.linkedPullRequest,
    true,
    serverThread?.pullRequests,
    serverThread?.branchPullRequest,
  );
  const currentLinkedPr = supportsMultiplePullRequests
    ? resolveThreadCurrentPullRequestLink(serverThread?.pullRequests ?? [])
    : null;
  const prBadge = supportsMultiplePullRequests
    ? resolveThreadPullRequestBadge(serverThread?.pullRequests)
    : null;
  const displayedPr = linkedStatus?.pr ?? (currentLinkedPr === null ? branchPr : null);
  const displayedPrStatus = prStatusIndicator(
    displayedPr,
    linkedStatus?.sourceControlProvider ?? branchStatusQuery.data?.sourceControlProvider,
  );
  const prNumber = currentLinkedPr?.number ?? displayedPr?.number;
  const prUrl = currentLinkedPr?.url ?? displayedPr?.url;
  const openPrLink = useOpenPrLink(threadRef);
  const panelPrLabel =
    prNumber === undefined
      ? ""
      : `#${prNumber}${displayedPr?.title.trim() ? `: ${displayedPr.title}` : ""}`;

  function selectPickerItem(itemValue: string) {
    if (itemValue === checkoutPullRequestItemValue && prReference && onCheckoutPullRequestRequest) {
      handleOpenChange(false);
      onComposerFocusRequest?.();
      onCheckoutPullRequestRequest(prReference);
    } else if (itemValue === createBranchItemValue) {
      createRef(trimmedBranchQuery);
    } else {
      const refName = branchByName.get(itemValue);
      if (refName) selectBranch(refName);
    }
  }

  function renderPickerItem(itemValue: string, index: number) {
    if (checkoutPullRequestItemValue && itemValue === checkoutPullRequestItemValue) {
      return (
        <ComboboxItem
          hideIndicator
          key={itemValue}
          index={index}
          value={itemValue}
          onClick={() => selectPickerItem(itemValue)}
        >
          <div className="flex min-w-0 items-center gap-2 py-1">
            <SourceControlIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-col items-start">
              <span className="truncate font-medium">
                Checkout {sourceControlPresentation.terminology.singular}
              </span>
              <span className="truncate text-muted-foreground text-xs">{prReference}</span>
            </span>
          </div>
        </ComboboxItem>
      );
    }
    if (createBranchItemValue && itemValue === createBranchItemValue) {
      return (
        <ComboboxItem
          hideIndicator
          key={itemValue}
          index={index}
          value={itemValue}
          onClick={() => selectPickerItem(itemValue)}
        >
          <span className="truncate">Create new ref &quot;{newRefName}&quot;</span>
        </ComboboxItem>
      );
    }

    const refName = branchByName.get(itemValue);
    if (!refName) return null;

    return (
      <BranchPickerRefItem
        branch={refName}
        projectCwd={activeProjectCwd}
        index={index}
        value={itemValue}
        disabled={
          !canUpdateThreadBranch ||
          (!canWriteSourceControl &&
            !isSelectingWorktreeBase &&
            (!activeProjectCwd ||
              !resolveBranchSelectionTarget({
                activeProjectCwd,
                activeWorktreePath,
                refName,
              }).reuseExistingWorktree))
        }
        onClick={() => selectPickerItem(itemValue)}
        onContextMenu={(event) => handleBranchContextMenu(event, itemValue)}
      />
    );
  }

  return (
    <BranchPicker
      items={branchPickerItems}
      filteredItems={filteredBranchPickerItems}
      open={isBranchMenuOpen}
      onOpenChange={handleOpenChange}
      onSelectItem={selectPickerItem}
      value={resolvedActiveBranch}
      query={branchQuery}
      resultsQuery={deferredTrimmedBranchQuery}
      onQueryChange={setBranchQuery}
      hasNextPage={hasNextPage}
      isFetchingNextPage={isFetchingNextPage}
      onLoadNext={branchRefState.loadNext}
      statusText={branchStatusText}
      renderItem={renderPickerItem}
      getItemType={(item) =>
        item === checkoutPullRequestItemValue
          ? "checkout-pull-request"
          : item === createBranchItemValue
            ? "create-branch"
            : "branch"
      }
      originControl={
        isSelectingWorktreeBase
          ? { checked: startFromOrigin, onCheckedChange: onStartFromOriginChange }
          : undefined
      }
      popupProps={{
        align: displayMode === "panel" ? "start" : "end",
        side: displayMode === "panel" ? "bottom" : "top",
        className: cn("flex flex-col", displayMode === "panel" ? "w-(--anchor-width)" : "w-80"),
        ...(displayMode === "toolbar" ? composerFloatingLayerProps : {}),
      }}
    >
      <div
        className={cn(
          "flex min-w-0",
          displayMode === "panel" ? "w-full flex-col items-stretch" : "items-center gap-1",
          className,
        )}
      >
        {displayMode !== "panel" ? (
          <ThreadPullRequestBadgeControl
            render={<ComposerControl size="xs" />}
            badge={prBadge}
            pullRequests={serverThread?.pullRequests ?? []}
            number={prNumber}
            url={prUrl}
            status={displayedPrStatus}
            onOpenList={() => useRightPanelStore.getState().open(threadRef, "pull-requests")}
            onOpenPullRequest={(event, targetUrl = prUrl) => {
              if (targetUrl) openPrLink(event, targetUrl);
            }}
          />
        ) : null}
        <span
          className="flex min-w-0"
          onMouseDownCapture={(event) => {
            if (event.button !== 0 || event.ctrlKey) {
              event.stopPropagation();
            }
          }}
          onContextMenu={(event) => handleBranchContextMenu(event, resolvedActiveBranch)}
        >
          <ComboboxTrigger
            render={
              displayMode === "panel" ? (
                <ThreadDetailsControl part="select" />
              ) : (
                <ComposerControl size="xs" />
              )
            }
            className="min-w-0 max-w-full active:scale-100"
            disabled={isInitialBranchesLoadPending || isBranchActionPending}
          >
            <GitBranchIcon
              className={cn(
                "size-3 shrink-0 opacity-70",
                displayMode === "panel" && THREAD_DETAILS_PANEL_ICON_CLASS,
              )}
            />
            <ComposerContextLabel displayMode={displayMode}>
              <MiddleTruncate value={triggerLabel} className="w-full" />
            </ComposerContextLabel>
            {displayMode !== "panel" ? (
              <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
            ) : null}
          </ComboboxTrigger>
        </span>
        {displayMode === "panel" && prNumber !== undefined && prUrl !== undefined ? (
          <ThreadDetailsPrRows
            threadRef={threadRef}
            links={serverThread?.pullRequests ?? []}
            currentLink={currentLinkedPr}
            onOpenLink={openPrLink}
            environmentId={environmentId}
            pr={displayedPr}
            number={prNumber}
            reference={currentLinkedPr}
            status={displayedPrStatus}
            project={activeProject}
            label={panelPrLabel}
            openAriaLabel={prUrl ?? "Open pull request"}
            onOpen={(event) => openPrLink(event, prUrl)}
            onActed={() => branchStatusQuery.refresh()}
          />
        ) : null}
      </div>
    </BranchPicker>
  );
}
