import { useProjects } from "../../state/entities";
import { ResourceActionLogs } from "./ResourceActionLogs";
import {
  groupedResourceLocks,
  resourceOwnersForAction,
} from "@t3tools/client-runtime/state/resource-lock-grouping";
import { resourceActionKey } from "@t3tools/shared/resourceActions";
import { useEnvironments } from "../../state/environments";
import { useMobileProjectGroupingSettings } from "../../state/project-grouping";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AppText } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { useRememberThreadProject } from "./useRememberThreadProject";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import { buildProjectThreadStartTurnInput } from "../../lib/projectThreadStartTurn";
import { useWorktreeSetup } from "./use-worktree-setup";
import { worktreeSetupAgentStarted } from "@t3tools/client-runtime/worktree-setup";
import { AppBar } from "../../components/ui/AppBar";
import {
  StackActions,
  useFocusEffect,
  useIsFocused,
  useNavigation,
  useRoute,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import {
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  DEFAULT_SERVER_SETTINGS,
  T3_PROJECT_FILE_NAME,
  type ProjectReadFileResult,
  EnvironmentId,
  ThreadId,
  type ProjectScript,
} from "@t3tools/contracts";
import {
  projectScriptCwd,
  projectScriptRuntimeEnv,
  projectScriptTerminalInput,
  resolveProjectScripts,
  resolveInheritedProjectScripts,
} from "@t3tools/shared/projectScripts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { Alert, Platform, Pressable, View } from "react-native";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMobileGitStatus } from "../../state/queries";
import { useWorkspaceState, useConnectionsReady } from "../../state/workspace";

import { useEnvironmentShellReadiness } from "../../state/shell";
import { restoredNewTaskDraftKey } from "../../state/new-task-draft-key";
import { clearPendingThreadCreationOutcome } from "../../state/pending-thread-creation";
import { recoverFailedThreadDraft } from "../../state/recover-failed-thread-draft";
import { useEnvironmentQuery } from "../../state/query";
import { dismissGitActionResult, useGitActionProgress } from "../../state/use-vcs-action-state";
import { vcsEnvironment } from "../../state/vcs";
import { EmptyState } from "../../components/ui/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { connectionTone } from "../connection/connectionTone";
import {
  useRemoteConnections,
  useRemoteConnectionStatus,
  useRemoteEnvironmentRuntime,
} from "../../state/use-remote-environment-registry";
import { useKnownTerminalSessions } from "../../state/use-terminal-session";
import { uuidv4 } from "../../lib/uuid";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useSelectedThreadDetailState } from "../../state/use-thread-detail";
import { useThreadSelection } from "../../state/use-thread-selection";
import { GitActionProgressOverlay } from "./GitActionProgressOverlay";
import {
  buildTerminalMenuSessions,
  nextOpenTerminalId,
  resolveProjectScriptTerminalId,
} from "../terminal/terminalMenu";
import {
  resolvePreferredThreadWorktreePath,
  stagePendingTerminalLaunch,
} from "../terminal/terminalLaunchContext";
import { terminalDebugLog } from "../terminal/terminalDebugLog";
import type { ThreadDetailScreenProps } from "./ThreadDetailScreen";
import { ThreadScreenBinding, ThreadScreenFallback, ThreadScreenHost } from "./ThreadScreenHost";
import { draftRouteIdentity } from "./thread-route-state";
import { NewTaskDraftRouteScreen, type NewTaskDraftRouteParams } from "./NewTaskDraftRouteScreen";
import { GitOverviewSheet } from "./git/GitOverviewSheet";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectedThreadGitActions } from "../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../state/use-selected-thread-git-state";
import { useSelectedThreadRequests } from "../../state/use-selected-thread-requests";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadComposerState } from "../../state/use-thread-composer-state";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { serverEnvironment } from "../../state/server";
import { projectEnvironment } from "../../state/projects";
import { resolveMergeBackTargetThreadId } from "@t3tools/client-runtime/state/thread-relationships";
import { resolveLatestMergeBackRun } from "@t3tools/client-runtime/state/thread-workflows";
import { useThreadFamily } from "../../state/threads";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import { newTaskDestination } from "./new-task-project-selection";
import { projectThreadContentPresentation } from "./threadContentPresentation";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  useAdaptiveWorkspaceLayout,
  useAdaptiveWorkspacePaneRole,
  useRegisterWorkspaceInspector,
} from "../layout/AdaptiveWorkspaceLayout";
import { ThreadFileNavigatorPane } from "../files/thread-file-navigator-pane";
import {
  ThreadInspectorContentStack,
  type ThreadInspectorMode,
} from "./thread-inspector-content-stack";
import { threadRouteIsHydrating } from "./thread-route-hydration";
import { ThreadHeader } from "./ThreadHeader";
import {
  useAndroidWorkspaceBack,
  useWorkspaceBackNavigation,
} from "../workspace/useAndroidWorkspaceNavigation";
import { openSettings } from "../settings/settings-navigation";
import {
  InspectorContentScope,
  ThreadInspectorHeader,
  ThreadInspectorPreview,
  type ThreadInspectorPresentation,
} from "./thread-inspector-preview";
import type { ThreadInspectorTarget } from "./thread-inspector-navigation";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";

function InspectorPaneRoleActivation() {
  useAdaptiveWorkspacePaneRole("inspector");
  return null;
}

// A blank param (a hand-typed deep link) is treated as missing, since branded
// IDs reject whitespace-only values.
function firstRouteParam(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first.trim().length === 0 ? null : first;
}

function ThreadRouteFallbackLayout(props: { readonly children: ReactNode }) {
  const goBack = useWorkspaceBackNavigation("threads");
  const { layout } = useAdaptiveWorkspaceLayout();
  const { themeVariables } = useAppearancePreferences();
  if (Platform.OS !== "android")
    return <ThreadScreenFallback>{props.children}</ThreadScreenFallback>;

  return (
    <>
      <AppBar
        title="Thread"
        options={{ contentStyle: { backgroundColor: themeVariables["--color-header"] } }}
        onBack={layout.usesSplitView ? undefined : goBack}
        hideBottomBorder
      />
      <ThreadScreenFallback>{props.children}</ThreadScreenFallback>
    </>
  );
}

function OpeningThreadLoadingScreen() {
  return (
    <ThreadRouteFallbackLayout>
      <LoadingScreen
        message="Opening thread…"
        messagePlacement="above-spinner"
        embedded={Platform.OS === "android"}
      />
    </ThreadRouteFallbackLayout>
  );
}

type ThreadRouteScreenRouteProps = StaticScreenProps<{
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly draft?: NewTaskDraftRouteParams;
  readonly inspector?: ThreadInspectorTarget;
  readonly prompt?: string | string[];
}>;

interface ThreadRouteScreenProps extends ThreadRouteScreenRouteProps {
  readonly inspectorPresentation?: ThreadInspectorPresentation;
  readonly onReturnToThread?: () => void;
  readonly renderInspector?: (headerInset: number) => ReactNode;
}

/** Shows recovery only after the target route has reached a terminal unavailable state. */
function ThreadUnavailableScreen(props: {
  readonly actionLabel: string;
  readonly onAction: () => void;
}) {
  return (
    <ThreadRouteFallbackLayout>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          paddingHorizontal: 24,
          paddingVertical: 32,
        }}
        className="bg-screen flex-1 android:bg-transparent"
      >
        <EmptyState
          title="Thread unavailable"
          detail="This thread is not available in the current mobile snapshot."
          actionLabel={props.actionLabel}
          onAction={props.onAction}
        />
      </ScrollView>
    </ThreadRouteFallbackLayout>
  );
}

/** A thread that can't load opens a new task in its environment instead of a dead end. */
function UnavailableThreadDraftRedirect(props: { readonly environmentId: EnvironmentId }) {
  const navigation = useNavigation();
  const projects = useProjects();
  const openDraft = useEffectEvent(() => {
    const project = projects.find((candidate) => candidate.environmentId === props.environmentId);
    navigation.dispatch(
      StackActions.replace("Thread", {
        draft: project
          ? {
              requestId: uuidv4(),
              environmentId: String(project.environmentId),
              projectId: String(project.id),
            }
          : { requestId: uuidv4() },
      }),
    );
  });
  // oxlint-disable-next-line t3code/react-effect-budget -- replaces this route in the navigator
  useEffect(() => {
    openDraft();
  }, []);
  return <OpeningThreadLoadingScreen />;
}

export function ThreadRouteScreen(props: ThreadRouteScreenProps) {
  return (
    <ThreadScreenHost>
      {props.route.params?.draft ? (
        <NewTaskDraftRouteScreen
          key={draftRouteIdentity(props.route.params.draft)}
          route={{ ...props.route, params: props.route.params.draft }}
        />
      ) : (
        <LiveThreadRouteController {...props} />
      )}
    </ThreadScreenHost>
  );
}

function LiveThreadRouteController(props: ThreadRouteScreenProps) {
  useAndroidWorkspaceBack("threads");
  const connectionsReady = useConnectionsReady();
  const { connectionState } = useRemoteConnectionStatus();
  const { selectedThread } = useThreadSelection();
  // Subagent rows, the open child's own row and its ancestors come from the family when the
  // shell leaves idle children out.
  useThreadFamily(
    selectedThread?.environmentId ?? null,
    selectedThread?.lineage.rootThreadId ?? null,
  );
  const params = props.route.params ?? {};
  const environmentIdRaw = firstRouteParam(params.environmentId);
  const threadIdRaw = firstRouteParam(params.threadId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const routeEnvironmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  const routeEnvironmentShellState = useEnvironmentShellReadiness(environmentId);
  const { onReconnectEnvironment } = useRemoteConnections();
  const navigation = useNavigation();
  const routeName = useRoute().name;
  const routeConnectionState =
    routeEnvironmentRuntime?.connectionState ?? (environmentId ? "available" : connectionState);
  const routeThreadKey =
    environmentId !== null && threadIdRaw !== null
      ? scopedThreadKey(environmentId, ThreadId.make(threadIdRaw))
      : null;
  const selectedThreadKey =
    selectedThread === null
      ? null
      : scopedThreadKey(selectedThread.environmentId, selectedThread.id);
  const selectedThreadDetailState = useSelectedThreadDetailState();
  const withInspectorHeader = (content: ReactNode) => (
    <>
      {props.inspectorPresentation ? (
        <ThreadInspectorHeader
          title={selectedThread?.title ?? "Thread"}
          {...props.inspectorPresentation}
        />
      ) : null}
      {content}
    </>
  );

  if (environmentId === null || threadIdRaw === null) {
    return withInspectorHeader(<OpeningThreadLoadingScreen />);
  }

  // Render the full thread chrome (header, feed, composer) as soon as the
  // thread SHELL is known — no blocking on message detail. The feed shows a
  // loading placeholder while messages fetch, the floating pill above the
  // composer reports loading/syncing, and the composer's connection pill
  // reports connecting/reconnecting status.
  if (selectedThread !== null && selectedThreadKey === routeThreadKey) {
    return withInspectorHeader(
      <ThreadRouteContent {...props} selectedThreadDetailState={selectedThreadDetailState} />,
    );
  }

  const stillHydrating = threadRouteIsHydrating({
    isLoadingConnections: !connectionsReady,
    environmentRegistered: routeEnvironmentRuntime !== null,
    localCacheRead:
      routeEnvironmentShellState.cacheRead &&
      selectedThreadDetailState !== EMPTY_ENVIRONMENT_THREAD_STATE,
    connectionState: routeConnectionState,
    shellStatus: routeEnvironmentShellState.status,
    shellHasError: routeEnvironmentShellState.hasError,
    detailStatus: selectedThreadDetailState.status,
    detailHasError: Option.isSome(selectedThreadDetailState.error),
  });

  if (stillHydrating) {
    return withInspectorHeader(<OpeningThreadLoadingScreen />);
  }

  if (routeName === "Thread" && !props.inspectorPresentation) {
    return <UnavailableThreadDraftRedirect environmentId={environmentId} />;
  }

  return withInspectorHeader(
    <ThreadUnavailableScreen
      actionLabel={
        routeEnvironmentRuntime === null ? "Manage environments" : "Reconnect environment"
      }
      onAction={() => {
        if (routeEnvironmentRuntime !== null) {
          onReconnectEnvironment(environmentId);
          return;
        }
        openSettings(navigation, "SettingsEnvironments");
      }}
    />,
  );
}

function ThreadRouteContent(
  props: ThreadRouteScreenProps & {
    readonly selectedThreadDetailState: ReturnType<typeof useSelectedThreadDetailState>;
  },
) {
  const { themeVariables } = useAppearancePreferences();
  const headerColor = themeVariables["--color-header"];
  const { fileInspector, layout, panes, showAuxiliaryPane, toggleAuxiliaryPane } =
    useAdaptiveWorkspaceLayout();
  const { connectionState } = useRemoteConnectionStatus();
  const { onReconnectEnvironment } = useRemoteConnections();
  const {
    selectedThread,
    selectedThreadCreation,
    selectedThreadDetailRef,
    selectedThreadProject,
    selectedEnvironmentConnection,
  } = useThreadSelection();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const groupingSettings = useMobileProjectGroupingSettings();
  const groupedLocks = (() =>
    selectedThreadProject
      ? groupedResourceLocks({
          activeProject: selectedThreadProject,
          projects,
          settings: {
            sidebarProjectGroupingMode: groupingSettings.sidebarProjectGroupingMode,
            sidebarProjectGroupingOverrides: {},
          },
          primaryEnvironmentId: null,
          connectedEnvironmentIds: new Set(
            environments
              .filter((entry) => entry.connection.phase === "connected")
              .map((entry) => entry.environmentId),
          ),
        })
      : [])();
  const resourceOwnerLabels = (() => {
    const labels = new Map<string, string>();
    for (const { project, lock } of groupedLocks) {
      const owner = appAtomRegistry.get(
        environmentThreadShells.threadShellAtom({
          environmentId: project.environmentId,
          threadId: lock.threadId,
        }),
      );
      labels.set(
        resourceActionKey(lock.script),
        `${owner?.title ?? lock.threadId} on ${environments.find((entry) => entry.environmentId === project.environmentId)?.label ?? project.environmentId}`,
      );
    }
    return labels;
  })();
  const selectedServerSettings = useAtomValue(
    serverEnvironment.settingsValueAtom(
      selectedThread?.environmentId ?? EnvironmentId.make("unavailable"),
    ),
  );
  const projectFileQuery = useEnvironmentQuery(
    selectedThreadProject
      ? projectEnvironment.readFile({
          environmentId: selectedThreadProject.environmentId,
          input: {
            cwd: selectedThreadProject.workspaceRoot,
            relativePath: T3_PROJECT_FILE_NAME,
          },
        })
      : null,
  );
  const projectFileData = projectFileQuery.data as ProjectReadFileResult | null;
  const fileScripts = (() => {
    if (projectFileData === null || projectFileData.truncated) return [];
    return parseT3ProjectFile(projectFileData.contents)?.scripts ?? [];
  })();
  const projectScripts = (() =>
    selectedThreadProject
      ? resolveInheritedProjectScripts(
          resolveProjectScripts(
            selectedServerSettings ?? DEFAULT_SERVER_SETTINGS,
            selectedThreadProject,
          ),
          fileScripts,
          selectedServerSettings?.globalScripts ?? [],
          selectedThreadProject.disabledInheritedScriptIds ?? [],
        )
      : [])();
  useRememberThreadProject(selectedThreadProject);
  const canOperateThread = useEnvironmentScope(
    selectedThread?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const canReadTerminal = useEnvironmentScope(
    selectedThread?.environmentId ?? null,
    AuthTerminalReadScope,
  );
  const canOperateTerminal = useEnvironmentScope(
    selectedThread?.environmentId ?? null,
    AuthTerminalOperateScope,
  );
  const selectedThreadDetailState = props.selectedThreadDetailState;
  const selectedThreadDetail = Option.getOrNull(selectedThreadDetailState.data);
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const composer = useThreadComposerState();
  const gitState = useSelectedThreadGitState();
  const requests = useSelectedThreadRequests();
  const requestResource = useAtomCommand(projectEnvironment.resource, "resource action");
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, "thread interrupt");
  const resumeThreadQueue = useAtomCommand(threadEnvironment.resumeThreadQueue, "resume queue");
  const loadEarlierHistory = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier thread history",
    reportFailure: false,
  });
  const historyControls = (() => {
    const history = selectedThreadDetailState.history;
    if (!selectedThread) {
      return undefined;
    }
    if (!history.hasMoreHistory && history.error === null) {
      return undefined;
    }
    return {
      hasMoreHistory: history.hasMoreHistory,
      loading: history.loading,
      error: history.error,
      onLoadEarlier: () => {
        void loadEarlierHistory({
          environmentId: selectedThread.environmentId,
          input: { threadId: selectedThread.id },
        });
      },
      onLoadThrough: (throughEntryId: string) => {
        void loadEarlierHistory({
          environmentId: selectedThread.environmentId,
          input: { threadId: selectedThread.id, throughEntryId },
        });
      },
    };
  })();
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const selectDetail = useSelectWorkspaceDetail();
  const openPullRequest = useOpenPullRequest();
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack, "merge thread back");
  const mergeBackTargetThreadId = resolveMergeBackTargetThreadId(selectedThreadDetail);
  const mergeBackRun =
    selectedThreadDetail === null ? null : resolveLatestMergeBackRun(selectedThreadDetail);
  const mergeBackBusyRef = useRef(false);
  const handleMergeBack = async () => {
    if (
      mergeBackBusyRef.current ||
      !selectedThread ||
      mergeBackTargetThreadId === null ||
      mergeBackRun === null
    ) {
      return;
    }
    mergeBackBusyRef.current = true;
    const result = await mergeBack({
      environmentId: selectedThread.environmentId,
      input: {
        sourceThreadId: selectedThread.id,
        targetThreadId: mergeBackTargetThreadId,
        runId: mergeBackRun.id,
        creationSource: "mobile",
      },
    });
    mergeBackBusyRef.current = false;
    if (result._tag !== "Success") return;
    selectDetail({
      name: "Thread",
      params: { environmentId: selectedThread.environmentId, threadId: mergeBackTargetThreadId },
    });
  };
  const params = props.route.params ?? {};
  const environmentIdRaw = firstRouteParam(params.environmentId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const threadId = firstRouteParam(params.threadId);
  const routeThreadIdentity =
    environmentIdRaw !== null && threadId !== null ? `${environmentIdRaw}:${threadId}` : null;
  // The chosen mode survives thread switches; "route" only applies while the route
  // supplies an inspector, which is also the default whenever it does.
  const [chosenInspectorMode, setChosenInspectorMode] = useState<ThreadInspectorMode | null>(null);
  const previewTarget = props.inspectorPresentation ? undefined : params.inspector;
  const inspectorMode = (() => {
    if (previewTarget) return "preview";
    const mode =
      props.renderInspector === undefined
        ? chosenInspectorMode === "route"
          ? null
          : chosenInspectorMode
        : chosenInspectorMode === null || chosenInspectorMode === "route"
          ? "route"
          : chosenInspectorMode;
    return mode === "files" && selectedThreadCwd === null ? null : mode;
  })();
  useEffect(() => {
    if (
      props.inspectorPresentation === undefined &&
      fileInspector.supported &&
      selectedThreadCwd === null &&
      inspectorMode === null &&
      panes.auxiliaryPaneVisible
    ) {
      toggleAuxiliaryPane();
    }
  }, [
    fileInspector.supported,
    inspectorMode,
    panes.auxiliaryPaneVisible,
    props.inspectorPresentation,
    selectedThreadCwd,
    toggleAuxiliaryPane,
  ]);

  const revealPreview = useEffectEvent(() => showAuxiliaryPane("inspector"));
  useEffect(() => {
    if (previewTarget) revealPreview();
  }, [previewTarget]);
  const routeEnvironmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  const routeConnectionState =
    routeEnvironmentRuntime?.connectionState ?? (environmentId ? "available" : connectionState);
  const routeConnectionError = routeEnvironmentRuntime?.connectionError ?? null;
  const selectedThreadWithDraftSettings = selectedThread
    ? {
        ...selectedThread,
        modelSelection: composer.modelSelection ?? selectedThread.modelSelection,
        runtimeMode: composer.runtimeMode ?? selectedThread.runtimeMode,
        interactionMode: composer.interactionMode ?? selectedThread.interactionMode,
      }
    : null;

  /* ─── Native header theming ──────────────────────────────────────── */
  const usesNativeHeaderGlass = NATIVE_LIQUID_GLASS_SUPPORTED;
  const headerSubtitle = [
    selectedThreadProject?.title ?? null,
    selectedEnvironmentConnection?.environmentLabel ?? null,
  ]
    .filter(Boolean)
    .join(" · ");
  /* ─── Git status for native header trigger ───────────────────────── */
  const gitStatus = useMobileGitStatus({
    active: true,
    focused: isFocused,
    platform: Platform.OS,
    route: { environmentId: environmentIdRaw ?? "", threadId: threadId ?? "" },
    selected:
      selectedThread === null
        ? null
        : {
            environmentId: selectedThread.environmentId,
            threadId: selectedThread.id,
            cwd: selectedThreadCwd,
          },
    surface: "thread-route",
  });
  const gitActions = useSelectedThreadGitActions({ active: gitStatus.target !== null });
  const { sessions: knownTerminalSessions } = useKnownTerminalSessions({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
  });
  const terminalMenuSessions = buildTerminalMenuSessions({
    knownSessions: knownTerminalSessions ?? [],
    workspaceRoot: selectedThreadProject?.workspaceRoot ?? null,
  });
  const selectedThreadDetailWorktreePath = selectedThreadDetail?.thread.worktreePath ?? null;
  const handleReconnectEnvironment = () => {
    if (!environmentId) {
      return;
    }
    onReconnectEnvironment(environmentId);
  };

  const gitActionProgressTarget = {
    environmentId: selectedThread?.environmentId ?? null,
    cwd: selectedThreadCwd,
  };
  const gitActionProgress = useGitActionProgress(gitActionProgressTarget);

  const handleOpenGitInspector = () => {
    if (!fileInspector.supported) {
      if (selectedThread === null) {
        return;
      }
      navigation.navigate("GitOverview", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
      });
      return;
    }
    navigation.setParams({ inspector: undefined });
    setChosenInspectorMode("git");
    showAuxiliaryPane("inspector");
  };
  const handleOpenFilesInspector = () => {
    if (selectedThread === null || selectedThreadCwd === null) {
      return;
    }
    if (!fileInspector.supported) {
      navigation.navigate("ThreadFiles", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
      });
      return;
    }
    navigation.setParams({ inspector: undefined });
    setChosenInspectorMode(props.renderInspector === undefined ? "files" : "route");
    showAuxiliaryPane("inspector");
  };
  const handleToggleInspector = () => {
    if (inspectorMode === null) {
      handleOpenFilesInspector();
      return;
    }
    toggleAuxiliaryPane();
  };
  const handleSelectInspectorFile = (path: string) => {
    if (selectedThread === null) {
      return;
    }
    const params = {
      environmentId: String(selectedThread.environmentId),
      threadId: String(selectedThread.id),
      path: path.split("/").filter((segment) => segment.length > 0),
    };
    if (fileInspector.supported) {
      navigation.navigate("ThreadFile", params);
      return;
    }
    navigation.navigate("ThreadFile", params);
  };
  const safeAreaInsets = useSafeAreaInsets();
  const inspectorHeaderInset = Platform.OS === "ios" ? 0 : safeAreaInsets.top;
  const renderGitInspector = ({ active }: { readonly active: boolean }) => (
    <GitOverviewSheet
      active={active}
      headerInset={inspectorHeaderInset}
      presentation="inspector"
      route={{ params: { environmentId: environmentId!, threadId: threadId! } }}
    />
  );
  const renderFilesInspector = () =>
    selectedThread !== null && selectedThreadCwd !== null ? (
      <ThreadFileNavigatorPane
        cwd={selectedThreadCwd}
        environmentId={selectedThread.environmentId}
        headerInset={inspectorHeaderInset}
        projectName={selectedThreadProject?.title ?? "Files"}
        selectedPath={null}
        onSelectFile={handleSelectInspectorFile}
      />
    ) : null;
  const renderRouteInspector = () => props.renderInspector?.(inspectorHeaderInset);
  const renderPreviewInspector = () =>
    previewTarget && panes.auxiliaryPaneVisible ? (
      <ThreadInspectorPreview
        target={previewTarget}
        renderThread={(screen) => <ThreadRouteScreen {...screen} />}
        onClose={toggleAuxiliaryPane}
        onOpen={(inspector) => {
          if (
            inspector.type === "thread" &&
            inspector.environmentId === environmentId &&
            inspector.threadId === threadId
          ) {
            toggleAuxiliaryPane();
            return;
          }
          navigation.setParams({ inspector });
        }}
      />
    ) : null;
  const renderInspectorStack = (registrationActive: boolean) =>
    inspectorMode === null ? null : (
      <ThreadInspectorContentStack
        paneVisible={panes.auxiliaryPaneVisible}
        registrationActive={registrationActive}
        renderPreview={renderPreviewInspector}
        renderFiles={renderFilesInspector}
        renderGit={renderGitInspector}
        mode={inspectorMode}
        resetKeys={[routeThreadIdentity, selectedThreadCwd]}
        renderRoute={props.renderInspector ? renderRouteInspector : undefined}
      />
    );
  const activeInspectorRenderer =
    props.inspectorPresentation || inspectorMode === null ? undefined : renderInspectorStack;
  useRegisterWorkspaceInspector(activeInspectorRenderer);

  const handleOpenConnectionEditor = () => {
    void navigation.navigate("Connections");
  };
  const handleStopThread = () => {
    if (
      !selectedThread ||
      !readEnvironmentScope(selectedThread.environmentId, AuthOrchestrationOperateScope) ||
      composer.interruptibleRunId === null
    ) {
      return;
    }
    return interruptThreadTurn({
      environmentId: selectedThread.environmentId,
      input: {
        threadId: selectedThread.id,
        runId: composer.interruptibleRunId,
      },
    });
  };

  const handleResumeQueue = async () => {
    if (!selectedThread) return;
    await resumeThreadQueue({
      environmentId: selectedThread.environmentId,
      input: { threadId: selectedThread.id },
    });
  };

  const handleOpenTerminal = (nextTerminalId?: string | null) => {
    terminalDebugLog("terminal-menu:open-existing", {
      terminalId: nextTerminalId ?? null,
      hasThread: Boolean(selectedThread),
      hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
    });

    if (
      !selectedThread ||
      !selectedThreadProject?.workspaceRoot ||
      (!readEnvironmentScope(selectedThread.environmentId, AuthTerminalReadScope) &&
        !readEnvironmentScope(selectedThread.environmentId, AuthTerminalOperateScope))
    ) {
      return;
    }

    void navigation.navigate("ThreadTerminal", {
      environmentId: String(selectedThread.environmentId),
      threadId: String(selectedThread.id),
      ...(nextTerminalId ? { terminalId: nextTerminalId } : {}),
    });
  };

  const handleOpenNewTerminal = () => {
    terminalDebugLog("terminal-menu:open-new", {
      hasThread: Boolean(selectedThread),
      hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
      listedTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
    });

    if (
      !selectedThread ||
      !selectedThreadProject?.workspaceRoot ||
      !readEnvironmentScope(selectedThread.environmentId, AuthTerminalOperateScope)
    ) {
      return;
    }

    const nextId = nextOpenTerminalId({
      listedTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
      ...(knownTerminalSessions === null ||
      !readEnvironmentScope(selectedThread.environmentId, AuthTerminalReadScope)
        ? { uniqueSuffix: uuidv4() }
        : {}),
    });
    void navigation.navigate("ThreadTerminal", {
      environmentId: String(selectedThread.environmentId),
      threadId: String(selectedThread.id),
      terminalId: nextId,
    });
  };

  const handleRunProjectScript = async (script: ProjectScript) => {
    terminalDebugLog("project-script:press", {
      scriptId: script.id,
      command: script.command,
      hasThread: Boolean(selectedThread),
      hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
    });

    if (
      !selectedThread ||
      !selectedThreadProject?.workspaceRoot ||
      !readEnvironmentScope(selectedThread.environmentId, AuthTerminalOperateScope)
    ) {
      terminalDebugLog("project-script:abort", {
        scriptId: script.id,
        reason: "no-thread-workspace-or-terminal-access",
      });
      return;
    }

    if (
      !selectedThread ||
      !selectedThreadProject?.workspaceRoot ||
      !readEnvironmentScope(selectedThread.environmentId, AuthTerminalOperateScope)
    ) {
      terminalDebugLog("project-script:abort", {
        scriptId: script.id,
        reason: "no-thread-workspace-or-terminal-access",
      });
      return;
    }

    if (script.resource) {
      const owners = resourceOwnersForAction(groupedLocks, script);
      const local = owners.find(
        (entry) =>
          entry.project.environmentId === selectedThreadProject.environmentId &&
          entry.project.id === selectedThreadProject.id,
      );
      const remote = owners.find((entry) => entry !== local);
      if (owners.length > 1 && local?.lock.threadId !== selectedThread.id) {
        Alert.alert(
          "Resource conflict",
          `Multiple threads hold ${script.name}. Release the conflicting checkouts first.`,
        );
        return;
      }
      const lock = local?.lock ?? remote?.lock;
      if (lock && (lock.phase === "checkout" || lock.phase === "release")) {
        Alert.alert("Resource busy", "Resource hooks are still running.");
        return;
      }
      const takingOver =
        lock !== undefined &&
        ((remote !== undefined && !local) || lock.threadId !== selectedThread.id);
      if (takingOver) {
        const ownerProject = local?.project ?? remote?.project;
        const owner = appAtomRegistry.get(
          environmentThreadShells.threadShellAtom({
            environmentId: ownerProject?.environmentId ?? selectedThread.environmentId,
            threadId: lock.threadId,
          }),
        );
        const environmentLabel =
          ownerProject && ownerProject.environmentId !== selectedThread.environmentId
            ? ` on ${environments.find((entry) => entry.environmentId === ownerProject.environmentId)?.label ?? ownerProject.environmentId}`
            : "";
        const confirmed = await new Promise<boolean>((resolve) => {
          Alert.alert(
            "Take over resource",
            `Taking over resource from ${owner?.title ?? lock.threadId}${environmentLabel}.`,
            [
              { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
              { text: "Take over", style: "destructive", onPress: () => resolve(true) },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
          );
        });
        if (!confirmed) return;
      }
      if (remote && !local) {
        const released = await requestResource({
          environmentId: remote.project.environmentId,
          input: {
            projectId: remote.project.id,
            threadId: remote.lock.threadId,
            script: remote.lock.script,
            action: "force-release",
            expectedOperationId: remote.lock.operationId,
          },
        });
        if (released._tag === "Failure") {
          if (!isAtomCommandInterrupted(released)) {
            const error = squashAtomCommandFailure(released);
            Alert.alert(
              "Resource action failed",
              error instanceof Error ? error.message : "Could not release the other checkout.",
            );
          }
          return;
        }
      }
      const result = await requestResource({
        environmentId: selectedThread.environmentId,
        input: {
          projectId: selectedThreadProject.id,
          threadId: selectedThread.id,
          script,
          action: local ? (takingOver ? "takeover" : "release") : "checkout",
          ...(local ? { expectedOperationId: local.lock.operationId } : {}),
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Alert.alert(
          "Resource action failed",
          error instanceof Error ? error.message : "Try again.",
        );
      }
      return;
    }

    const targetTerminalId = resolveProjectScriptTerminalId({
      existingTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
      ...(knownTerminalSessions === null ||
      !readEnvironmentScope(selectedThread.environmentId, AuthTerminalReadScope)
        ? { uniqueSuffix: uuidv4() }
        : {}),
      hasRunningTerminal: terminalMenuSessions.some(
        (session) => session.status === "running" || session.status === "starting",
      ),
    });
    const preferredWorktreePath = resolvePreferredThreadWorktreePath({
      threadShellWorktreePath: selectedThread.worktreePath ?? null,
      threadDetailWorktreePath: selectedThreadDetailWorktreePath,
    });
    const cwd = projectScriptCwd({
      project: { cwd: selectedThreadProject.workspaceRoot },
      worktreePath: preferredWorktreePath,
    });
    const env = projectScriptRuntimeEnv({
      project: { cwd: selectedThreadProject.workspaceRoot },
      worktreePath: preferredWorktreePath,
    });
    stagePendingTerminalLaunch({
      target: {
        environmentId: selectedThread.environmentId,
        threadId: selectedThread.id,
        terminalId: targetTerminalId,
      },
      launch: {
        cwd,
        worktreePath: preferredWorktreePath,
        env,
        initialInput: projectScriptTerminalInput(script.command),
      },
    });
    terminalDebugLog("project-script:staged", {
      scriptId: script.id,
      terminalId: targetTerminalId,
      cwd,
      worktreePath: preferredWorktreePath,
    });

    void navigation.navigate("ThreadTerminal", {
      environmentId: String(selectedThread.environmentId),
      threadId: String(selectedThread.id),
      terminalId: targetTerminalId,
    });
  };
  const threadGitControlProps = {
    environmentId: environmentIdRaw ?? "",
    threadId: threadId ?? "",
    gitCwd: selectedThreadCwd,
    auxiliaryPaneControl:
      !layout.usesSplitView && fileInspector.supported && selectedThreadCwd !== null
        ? {
            accessibilityLabel: "Toggle inspector",
            onPress: handleToggleInspector,
          }
        : undefined,
    onOpenFilesInspector:
      fileInspector.supported && selectedThreadCwd !== null ? handleOpenFilesInspector : undefined,
    onOpenGitInspector: fileInspector.supported ? handleOpenGitInspector : undefined,
    onMergeBack:
      mergeBackTargetThreadId !== null && mergeBackRun !== null
        ? () => void handleMergeBack()
        : undefined,
    currentBranch: selectedThread?.branch ?? null,
    gitStatus: gitStatus.data,
    gitOperationLabel: gitState.gitOperationLabel,
    canOpenTerminal:
      Boolean(selectedThreadProject?.workspaceRoot) && (canReadTerminal || canOperateTerminal),
    canOperateTerminal,
    canOpenFiles: Boolean(selectedThreadProject?.workspaceRoot),
    projectScripts,
    resourceLocks: groupedLocks,
    resourceOwnerLabels,
    terminalSessions: terminalMenuSessions,
    showDirectFileControl: layout.usesSplitView,
    onOpenTerminal: handleOpenTerminal,
    onOpenNewTerminal: handleOpenNewTerminal,
    onRunProjectScript: handleRunProjectScript,
    onPull: gitActions.onPullSelectedThreadBranch,
    onRunAction: gitActions.onRunSelectedThreadGitAction,
  };
  const handleEditFailedCreation = async () => {
    const creation = selectedThreadCreation?.message;
    if (!creation?.creation || routeThreadIdentity === null) {
      return;
    }
    // Open recovery by draft id or the sheet creates an empty draft and strands restored content.
    try {
      await recoverFailedThreadDraft(creation);
    } catch (error) {
      Dialog.alert(
        "Could not restore draft",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    clearPendingThreadCreationOutcome(routeThreadIdentity);
    navigation.dispatch(
      StackActions.replace("Thread", {
        draft: {
          draftId: restoredNewTaskDraftKey(creation.messageId),
          environmentId: String(creation.environmentId),
          projectId: String(creation.creation.projectId),
          ...(selectedThreadProject ? { title: selectedThreadProject.title } : {}),
        },
      }),
    );
  };
  const setupTurnStartedAt = composer.selectedThreadActivityRun?.startedAt ?? null;
  const { snapshot: worktreeSetupSnapshot, visible: worktreeSetup } = useWorktreeSetup({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
    preparing:
      composer.selectedThreadActivityRun?.status === "preparing" ||
      selectedThread?.runtime?.status === "preparing" ||
      selectedThread?.worktreePath != null ||
      (selectedThreadCreation?.message.creation?.workspaceMode === "worktree" &&
        selectedThreadCreation.outcome == null),
    turnStarted: setupTurnStartedAt !== null,
    followUpSent:
      composer.selectedThreadFeed.filter(
        (entry) => entry.type === "message" && entry.message.role === "user",
      ).length +
        composer.selectedThreadQueueCount >
      1,
  });
  const awaitingBootstrapTurn =
    worktreeSetup !== null
      ? worktreeSetup.phase === "running" && !worktreeSetupAgentStarted(worktreeSetup)
      : (selectedThreadDetail?.runs.some((run) => run.status === "preparing") ?? false);
  const cancelWorktreeSetup = useAtomCommand(vcsEnvironment.cancelWorktreeSetup);
  const handleCancelWorktreeSetup = () => {
    if (!selectedThread) return;
    void cancelWorktreeSetup({
      environmentId: selectedThread.environmentId,
      input: { threadId: selectedThread.id },
    });
  };
  const startLocalThread = useAtomCommand(threadEnvironment.startTurn, "work locally");
  const localResendBusy = useRef(false);
  const setupMessage = selectedThreadDetail?.messages.find((message) => message.role === "user");
  const handleWorkLocally = async () => {
    if (!selectedThread || !selectedThreadProject || !setupMessage || localResendBusy.current)
      return;
    localResendBusy.current = true;
    const result = await cancelWorktreeSetup({
      environmentId: selectedThread.environmentId,
      input: { threadId: selectedThread.id },
    });
    if (result._tag !== "Success" || !result.value.cancelled) {
      localResendBusy.current = false;
      return;
    }
    // V2 accepts launch before setup; cancellation cannot reject that delivery, so reuse server-owned prompt and uploads.
    const metadata = makeTurnCommandMetadata();
    const launched = await startLocalThread({
      environmentId: selectedThread.environmentId,
      input: buildProjectThreadStartTurnInput({
        ...metadata,
        projectId: selectedThread.projectId,
        projectCwd: selectedThreadProject.workspaceRoot,
        text: setupMessage.text,
        titleText: selectedThread.title,
        ...(setupMessage.context ? { context: setupMessage.context } : {}),
        uploadedAttachments: setupMessage.attachments,
        modelSelection: selectedThread.modelSelection,
        runtimeMode: selectedThread.runtimeMode,
        interactionMode: selectedThread.interactionMode,
        workspaceMode: "local",
        branch: null,
        worktreePath: null,
        startFromOrigin: false,
        worktreeBranchName: "",
      }),
    });
    localResendBusy.current = false;
    if (launched._tag !== "Success") return;
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: String(selectedThread.environmentId),
        threadId: metadata.threadId,
      }),
    );
  };
  const creationState = ((): ThreadDetailScreenProps["creationState"] => {
    if (selectedThreadCreation === null) {
      return awaitingBootstrapTurn
        ? { kind: "preparing", preparingWorktree: true, serverOwned: true }
        : null;
    }
    if (selectedThreadCreation.outcome?.kind === "failed") {
      return {
        kind: "failed",
        reason: selectedThreadCreation.outcome.reason,
        onEditTask: handleEditFailedCreation,
      };
    }
    return {
      kind: "preparing",
      preparingWorktree: selectedThreadCreation.message.creation?.workspaceMode === "worktree",
      serverOwned: false,
    };
  })();
  if (!environmentId || !threadId) {
    return <OpeningThreadLoadingScreen />;
  }

  if (!selectedThread) {
    return <OpeningThreadLoadingScreen />;
  }

  // Queued creation displays its prompt before server creation; temporary not-found is expected.
  const contentPresentation =
    creationState !== null
      ? { kind: "ready" as const }
      : projectThreadContentPresentation({
          hasDetail: selectedThreadDetail !== null,
          detailError: Option.getOrNull(selectedThreadDetailState.error),
          detailDeleted: selectedThreadDetailState.status === "deleted",
          connectionState: routeConnectionState,
        });
  const serverConfig = routeEnvironmentRuntime?.serverConfig ?? null;
  const renderThreadRouteBody = () => (
    <>
      <GitActionProgressOverlay
        progress={gitActionProgress}
        onDismiss={dismissGitActionResult}
        onOpenPullRequest={openPullRequest}
      />

      <>
        {selectedThread &&
          selectedThreadProject?.resourceLocks
            ?.filter((lock) => lock.threadId === selectedThread.id)
            .map((lock) => (
              <View
                key={lock.script.id}
                style={{ borderLeftWidth: 3, borderColor: lock.script.resource?.color }}
                className="flex-row flex-wrap items-center gap-3 px-4 py-2"
              >
                <AppText className="text-xs">
                  {lock.script.name} · {lock.phase === "held" ? "Checked out" : lock.phase}
                </AppText>
                {lock.error && <AppText className="text-xs">{lock.error}</AppText>}
                {(lock.phase === "checkout" || lock.phase === "release") && (
                  <Pressable
                    accessibilityRole="button"
                    disabled={lock.cancelRequested}
                    onPress={() =>
                      void requestResource({
                        environmentId: selectedThread.environmentId,
                        input: {
                          projectId: selectedThreadProject.id,
                          threadId: selectedThread.id,
                          script: lock.script,
                          action: "abort",
                          expectedOperationId: lock.operationId,
                        },
                      })
                    }
                  >
                    <AppText className="text-xs">
                      {lock.cancelRequested ? "Aborting…" : "Abort"}
                    </AppText>
                  </Pressable>
                )}
                {(lock.phase === "held" || lock.phase === "failed") && (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void handleRunProjectScript(lock.script)}
                  >
                    <AppText className="text-xs">Release</AppText>
                  </Pressable>
                )}
                {lock.phase === "failed" && (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() =>
                      void requestResource({
                        environmentId: selectedThread.environmentId,
                        input: {
                          projectId: selectedThreadProject.id,
                          threadId: selectedThread.id,
                          script: lock.script,
                          action: "force-release",
                          expectedOperationId: lock.operationId,
                        },
                      })
                    }
                  >
                    <AppText className="text-xs">Force release</AppText>
                  </Pressable>
                )}
              </View>
            ))}
        <ResourceActionLogs turnItems={selectedThreadDetail?.turnItems ?? []} />
        <ThreadScreenBinding
          header={
            props.inspectorPresentation ? null : (
              <ThreadHeader
                title={selectedThread.title}
                subtitle={headerSubtitle}
                headerColor={headerColor}
                usesNativeHeaderGlass={usesNativeHeaderGlass}
                gitControls={threadGitControlProps}
                hasThreadCwd={selectedThreadCwd !== null}
                hasWorkspaceRoot={Boolean(selectedThreadProject?.workspaceRoot)}
                fileInspectorSupported={fileInspector.supported}
                inspectorMode={inspectorMode}
                onToggleInspector={handleToggleInspector}
                onOpenGitInspector={handleOpenGitInspector}
                onOpenFilesInspector={handleOpenFilesInspector}
                onReturnToThread={props.onReturnToThread}
              />
            )
          }
          canOperateThread={canOperateThread}
          selectedThread={selectedThreadWithDraftSettings ?? selectedThread}
          selectedThreadDetailRef={selectedThreadDetailRef}
          contentPresentation={contentPresentation}
          screenTone={connectionTone(routeConnectionState)}
          connectionError={routeConnectionError}
          environmentLabel={selectedEnvironmentConnection?.environmentLabel ?? null}
          feedbackSubmissions={composer.feedbackSubmissions}
          onDismissFeedback={composer.dismissFeedback}
          selectedThreadFeed={composer.selectedThreadFeed}
          pendingHandoff={composer.pendingHandoff}
          activityRun={composer.selectedThreadActivityRun}
          activeWorkStartedAt={
            creationState?.kind === "preparing" ||
            (worktreeSetup !== null && setupTurnStartedAt === null)
              ? null
              : composer.activeWorkStartedAt
          }
          isCompacting={composer.isCompacting}
          runlessWorkActive={composer.runlessWorkActive}
          providerSubagentStatus={composer.providerSubagentStatus}
          creationState={creationState}
          setupWorkingStartedAt={
            composer.activeWorkStartedAt !== null &&
            worktreeSetupSnapshot !== null &&
            composer.selectedThreadFeed.filter(
              (entry) => entry.type === "message" && entry.message.role === "user",
            ).length <= 1
              ? composer.activeWorkStartedAt
              : null
          }
          worktreeSetup={
            worktreeSetup
              ? {
                  snapshot: worktreeSetup,
                  turnStartedAt: setupTurnStartedAt,
                  working: composer.activeWorkStartedAt !== null,
                  turnStarted: setupTurnStartedAt !== null,
                  onCancel: handleCancelWorktreeSetup,
                  onWorkLocally: setupMessage && selectedThreadProject ? handleWorkLocally : null,
                }
              : null
          }
          activePendingApproval={requests.activePendingApproval}
          activePendingApprovals={requests.activePendingApprovals}
          respondingApprovalId={requests.respondingApprovalId}
          activePendingUserInput={requests.activePendingUserInput}
          activePendingUserInputDrafts={requests.activePendingUserInputDrafts}
          activePendingUserInputAnswers={requests.activePendingUserInputAnswers}
          respondingUserInputId={requests.respondingUserInputId}
          connectionStateLabel={routeConnectionState}
          threadSyncStatus={selectedThreadDetailState.status}
          historyControls={historyControls}
          activeThreadBusy={composer.activeThreadBusy}
          canStopThread={awaitingBootstrapTurn || composer.interruptibleRunId !== null}
          queuedRunEdit={composer.queuedRunEdit}
          composerDraftKey={composer.composerDraftKey}
          followUpBehavior={composer.followUpBehavior}
          canSteerActiveTurn={composer.canSteerActiveTurn}
          isSavingQueuedEdit={composer.isSavingQueuedEdit}
          onCancelQueuedRunEdit={composer.cancelQueuedRunEdit}
          onRemoveQueuedEditAttachment={composer.onRemoveQueuedEditAttachment}
          environmentId={selectedThread.environmentId}
          projectWorkspaceRoot={selectedThreadProject?.workspaceRoot ?? null}
          threadCwd={selectedThreadCwd}
          selectedThreadQueueCount={composer.selectedThreadQueueCount}
          queuedMessages={
            selectedThreadCreation && selectedThreadCreation.outcome?.kind !== "delivered"
              ? [selectedThreadCreation.message, ...composer.selectedThreadQueuedMessages]
              : composer.selectedThreadQueuedMessages
          }
          dispatchingMessageId={composer.dispatchingQueuedMessageId}
          layoutVariant={layout.variant}
          usesAutomaticContentInsets={usesNativeHeaderGlass}
          onOpenConnectionEditor={handleOpenConnectionEditor}
          onChangeDraftMessage={composer.onChangeDraftMessage}
          onPickDraftMedia={composer.onPickDraftMedia}
          onPickDraftFiles={composer.onPickDraftFiles}
          onNativePasteImages={composer.onNativePasteImages}
          onNativePasteText={composer.onNativePasteText}
          onRemoveDraftImage={composer.onRemoveDraftImage}
          serverConfig={serverConfig}
          onStopThread={awaitingBootstrapTurn ? handleCancelWorktreeSetup : handleStopThread}
          onResumeQueue={composer.queueHeld ? handleResumeQueue : null}
          onSendMessage={composer.onSendMessage}
          onReconnectEnvironment={handleReconnectEnvironment}
          canSwitchThreadProvider={composer.canSwitchThreadProvider}
          onUpdateThreadInteractionMode={composer.onUpdateInteractionMode}
          onRespondToApproval={requests.onRespondToApproval}
          onSelectUserInputOption={requests.onSelectUserInputOption}
          onChangeUserInputCustomAnswer={requests.onChangeUserInputCustomAnswer}
          onSubmitUserInput={requests.onSubmitUserInput}
          onDismissUserInput={requests.onDismissUserInput}
        />
      </>
    </>
  );

  return (
    <>
      {activeInspectorRenderer ? <InspectorPaneRoleActivation /> : null}

      {renderThreadRouteBody()}
    </>
  );
}

export function FullscreenThreadRouteScreen(
  props: StaticScreenProps<{
    readonly environmentId: string;
    readonly threadId: string;
  }>,
) {
  const navigation = useNavigation();
  return (
    <InspectorContentScope>
      <ThreadRouteScreen
        route={props.route}
        inspectorPresentation={{ onClose: () => navigation.goBack() }}
      />
    </InspectorContentScope>
  );
}
