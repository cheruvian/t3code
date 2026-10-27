import { resolveDraftPromotionNavigationTarget } from "../composerDraftStore";
import {
  resolveUncertainSendRecovery,
  shouldMountDiffPanel,
  shouldMountDiffWorkerPool,
  resolveVisibleWorktreeSetup,
  recallCheckoutIsRepo,
  rememberCheckoutIsRepo,
  threadShellHasStarted,
  agentControlledBrowserCloseConfirmation,
  getAntigravitySendBlockReason,
  resolveBackgroundDraftWorkspaceOptions,
  resolveComposerInteractionMode,
  resolveComposerProviderSelection,
  resolveProactiveTurnDiffAction,
  resolveDraftHeroState,
  resolveWorktreeSetupProgress,
  isPaintOnlyThreadTimeline,
  peekHeldThreadTimeline,
  rememberReadyThreadTimeline,
  resetHeldThreadTimeline,
  resolveThreadSwitchTimeline,
  codexArtifactTemplatePromptToAppend,
  shouldDockDraftHeroForSubmission,
  shouldReleaseTimelineAnchorForToolActivity,
  shouldRefocusComposerOnWindowFocus,
  shouldOpenProactivePullRequest,
  shouldRetargetThreadPullRequestPanel,
  shouldOpenProactiveTurnDiff,
  shouldRenderPreviewMiniPlayer,
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  branchMismatchKey,
  buildExpiredTerminalContextToastCopy,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  deriveLockedProvider,
  dismissBranchMismatchForSession,
  getStartedThreadModelChangeBlockReason,
  hasServerAcknowledgedLocalDispatch,
  isBranchMismatchDismissedForSession,
  reconcileMountedTerminalThreadIds,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  startNewThreadForProject,
  shouldShowBranchMismatchBanner,
  shouldShowPlanFollowUpPrompt,
  makeThreadErrorSetter,
  waitForRevertedMessage,
} from "./ChatView.logic";

import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  type ServerProvider,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  RunId,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import { deriveProviderInstanceEntries, NO_PROVIDER_MODEL_SELECTION } from "../providerInstances";
import {
  type RightPanelSurface,
  useRightPanelStore,
  selectActiveRightPanel,
} from "../rightPanelStore";

import type { CodexArtifactTemplate } from "@t3tools/shared/codexArtifactTemplates";

import * as Option from "effect/Option";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails } from "../state/threads";

import type { Thread, TurnDiffSummary } from "../types";
import { makeThreadFixture, makeThreadProjectionFixture } from "../test-fixtures";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-03-29T00:00:00.000Z";
const helloWorldTemplate: CodexArtifactTemplate = {
  artifactKind: "document",
  displayName: "Hello World",
  skillDirectory: "/Users/test/.codex/skills/artifact-template-hello-world",
  skillName: "artifact-template-hello-world",
};

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    id: threadId,
    environmentId,
    projectId,
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    runtime: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
}

const completedTurn = {
  runId: RunId.make("turn-1"),
  status: "completed" as const,
  requestedAt: now,
  startedAt: "2026-03-29T00:00:01.000Z",
  completedAt: "2026-03-29T00:00:10.000Z",
  assistantMessageId: null,
};

const readySession = {
  status: "completed" as const,
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  activeRunId: null,
  lastError: null,
  updatedAt: "2026-03-29T00:00:10.000Z",
};

describe("resolveDraftPromotionNavigationTarget", () => {
  const serverThreadRef = { environmentId, threadId };
  const preparingRun = {
    ...completedTurn,
    status: "preparing" as const,
    startedAt: null,
    completedAt: null,
  };

  it("stays on the draft until the server owns the send", () => {
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread: makeThread({ latestRun: preparingRun }),
        backgroundSubmissionPending: false,
      }),
    ).toBeNull();
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread: makeThread(),
        backgroundSubmissionPending: false,
      }),
    ).toBeNull();
  });

  it("promotes a persisted send while its worktree is still preparing", () => {
    const serverThread = makeThread({ latestRun: preparingRun, latestUserMessageAt: now });
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread,
        backgroundSubmissionPending: false,
      }),
    ).toBe(serverThreadRef);
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread,
        backgroundSubmissionPending: true,
      }),
    ).toBeNull();
  });

  it("navigates once the run starts or startup stops", () => {
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread: makeThread({ latestRun: completedTurn }),
        backgroundSubmissionPending: false,
      }),
    ).toBe(serverThreadRef);
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread: makeThread({
          latestRun: { ...preparingRun, status: "failed" as const },
        }),
        backgroundSubmissionPending: false,
      }),
    ).toBe(serverThreadRef);
  });

  it("defers while a background submission is pending", () => {
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread: makeThread({ latestRun: completedTurn }),
        backgroundSubmissionPending: true,
      }),
    ).toBeNull();
  });
});

describe("resolveEffectiveInteractionMode", () => {
  it("forces build mode when legacy plan mode is disabled", () => {
    expect(
      resolveComposerInteractionMode({
        planModeEnabled: false,
        provider: { showInteractionModeToggle: true },
        interactionMode: "plan",
      }).interactionMode,
    ).toBe("default");
  });

  it("uses the saved mode while legacy plan mode is enabled", () => {
    expect(
      resolveComposerInteractionMode({
        planModeEnabled: true,
        provider: { showInteractionModeToggle: true },
        interactionMode: "plan",
      }).interactionMode,
    ).toBe("plan");
  });
});

describe("resolveThreadMetadataUpdateForNextTurn", () => {
  const modelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };

  it("updates a stale local thread branch to the active checkout", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        currentBranch: "feature/thread",
        nextBranch: "feature/checkout",
      }),
    ).toEqual({ branch: "feature/checkout", worktreePath: null });
  });

  it("does not write metadata when the model and branch are unchanged", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        nextModelSelection: modelSelection,
        currentBranch: "feature/current",
        nextBranch: "feature/current",
      }),
    ).toBeNull();
  });
});

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "[Terminal 1](t3-context://v1/terminal/ctx-expired)",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("treats element contexts as sendable content (no text, no images, no terminals)", () => {
    const state = deriveComposerSendState({
      prompt: "",
      imageCount: 0,
      terminalContexts: [],
      elementContextCount: 1,
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.expiredTerminalContextCount).toBe(0);
    expect(state.hasSendableContent).toBe(true);
  });

  it("does NOT treat zero element contexts as sendable", () => {
    expect(
      deriveComposerSendState({
        prompt: "",
        imageCount: 0,
        terminalContexts: [],
        elementContextCount: 0,
      }).hasSendableContent,
    ).toBe(false);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats empty and omission guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("getStartedThreadModelChangeBlockReason", () => {
  const providers = [
    {
      instanceId: ProviderInstanceId.make("codex"),
    },
    {
      instanceId: ProviderInstanceId.make("grok"),
      requiresNewThreadForModelChange: true,
    },
  ];

  it("allows model changes before a provider session has started", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: false,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-other",
        },
      }),
    ).toBeNull();
  });

  it("allows unchanged model selections for restricted providers", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
      }),
    ).toBeNull();
  });

  it("blocks started-session model changes for providers that require a new thread", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-other",
        },
      }),
    ).toEqual({
      title: "Start a new chat to change models",
      description:
        "This provider does not allow switching models after a conversation has started.",
    });
  });
});

describe("resolveSendEnvMode", () => {
  it("keeps worktree mode only for git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: true })).toBe("worktree");
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: false })).toBe("local");
  });
});

describe("branchMismatchKey", () => {
  it("builds a key from thread id and both branches", () => {
    expect(branchMismatchKey("thread-1", { threadBranch: "feat/a", currentBranch: "feat/b" })).toBe(
      "thread-1:feat/a:feat/b",
    );
  });

  it("returns null without a thread or mismatch", () => {
    expect(branchMismatchKey(null, { threadBranch: "a", currentBranch: "b" })).toBeNull();
    expect(branchMismatchKey("thread-1", null)).toBeNull();
  });
});

describe("shouldShowBranchMismatchBanner", () => {
  const base = {
    hasMismatch: true,
    isDismissed: false,
    composerHasContent: false,
    wasShownForCurrentMismatch: false,
  };

  it("stays hidden during passive browsing (even though the composer autofocuses)", () => {
    expect(shouldShowBranchMismatchBanner(base)).toBe(false);
  });

  it("shows once the composer has draft content", () => {
    expect(shouldShowBranchMismatchBanner({ ...base, composerHasContent: true })).toBe(true);
  });

  it("stays mounted after the draft clears once shown for the current mismatch", () => {
    expect(shouldShowBranchMismatchBanner({ ...base, wasShownForCurrentMismatch: true })).toBe(
      true,
    );
  });

  it("never shows when dismissed or without a mismatch", () => {
    expect(
      shouldShowBranchMismatchBanner({ ...base, composerHasContent: true, isDismissed: true }),
    ).toBe(false);
    expect(
      shouldShowBranchMismatchBanner({ ...base, composerHasContent: true, hasMismatch: false }),
    ).toBe(false);
  });
});

describe("shouldShowPlanFollowUpPrompt", () => {
  const base = {
    pendingUserInputCount: 0,
    interactionMode: "plan" as const,
    latestTurnSettled: true,
    hasActionableProposedPlan: true,
    hasComposerAttachments: false,
  };

  it("shows plan actions for a settled actionable plan without attachments", () => {
    expect(shouldShowPlanFollowUpPrompt(base)).toBe(true);
  });

  it("hides plan actions while the composer has staged attachments", () => {
    expect(shouldShowPlanFollowUpPrompt({ ...base, hasComposerAttachments: true })).toBe(false);
  });

  it("preserves the existing plan follow-up gates", () => {
    expect(shouldShowPlanFollowUpPrompt({ ...base, pendingUserInputCount: 1 })).toBe(false);
    expect(shouldShowPlanFollowUpPrompt({ ...base, interactionMode: "default" })).toBe(false);
    expect(shouldShowPlanFollowUpPrompt({ ...base, latestTurnSettled: false })).toBe(false);
    expect(shouldShowPlanFollowUpPrompt({ ...base, hasActionableProposedPlan: false })).toBe(false);
  });
});

describe("session branch mismatch dismissal", () => {
  it("tracks dismissed keys and treats other keys as active", () => {
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(false);
    dismissBranchMismatchForSession("t1:a:b");
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(true);
    expect(isBranchMismatchDismissedForSession("t1:a:c")).toBe(false);
    expect(isBranchMismatchDismissedForSession(null)).toBe(false);
  });
});

describe("reconcileMountedTerminalThreadIds", () => {
  it("keeps open threads and makes the active thread most recent", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ["thread-a", "thread-b", "thread-c"],
        openThreadIds: ["thread-a", "thread-b", "thread-c"],
        activeThreadId: "thread-a",
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual(["thread-b", "thread-c", "thread-a"]);
  });

  it("drops closed threads and enforces the hidden mounted cap", () => {
    const ids = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS + 2 },
      (_, index) => `thread-${index}`,
    );
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ids,
        openThreadIds: ids.slice(1),
        activeThreadId: null,
        activeThreadTerminalOpen: false,
      }),
    ).toEqual(ids.slice(-MAX_HIDDEN_MOUNTED_TERMINAL_THREADS));
  });
});

describe("makeThreadErrorSetter", () => {
  it("writes server errors only for the matching environment, route and target", () => {
    const routeThreadRef = { environmentId, threadId };
    for (const serverThreadRef of [
      routeThreadRef,
      null,
      { environmentId: EnvironmentId.make("other-environment"), threadId },
    ]) {
      const setServer = vi.fn();
      const setDraft = vi.fn();
      const setError = makeThreadErrorSetter({
        routeThreadRef,
        routeThreadKey: "route-key",
        draftId: null,
        serverThreadRef,
        setLocalServerErrorsByThreadKey: setServer,
        setLocalDraftErrorsByDraftId: setDraft,
      });
      setError(threadId, "Failed to send");
      expect(setServer).toHaveBeenCalledTimes(serverThreadRef === routeThreadRef ? 1 : 0);
      expect(setDraft).toHaveBeenCalledTimes(serverThreadRef === routeThreadRef ? 0 : 1);
      if (serverThreadRef === routeThreadRef) {
        expect(setServer.mock.calls[0]![0]({})).toMatchObject({
          "route-key": { message: "Failed to send" },
        });
      }
      setServer.mockClear();
      setError(ThreadId.make("other-thread"), "Failed in another thread");
      expect(setServer).not.toHaveBeenCalled();
    }
  });
});

describe("startNewThreadForProject", () => {
  it("starts a thread through the supplied shared handler for the active project", () => {
    const calls: Array<{ environmentId: EnvironmentId; projectId: ProjectId }> = [];
    const projectRef = { environmentId, projectId };

    expect(
      startNewThreadForProject(projectRef, (nextProjectRef) => {
        calls.push(nextProjectRef);
        return Promise.resolve();
      }),
    ).toBe(true);
    expect(calls).toEqual([projectRef]);
  });

  it("does nothing when the active project is unavailable", () => {
    let called = false;

    expect(
      startNewThreadForProject(null, () => {
        called = true;
        return Promise.resolve();
      }),
    ).toBe(false);
    expect(called).toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  it("does not acknowledge unchanged server state", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestRun: completedTurn, runtime: readySession }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestRun: completedTurn,
        runtime: readySession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("acknowledges pending user interaction and errors immediately", () => {
    const localDispatch = createLocalDispatchSnapshot(makeThread());
    const common = {
      localDispatch,
      phase: "ready" as const,
      latestRun: null,
      runtime: null,
      hasPendingApproval: false,
      hasPendingUserInput: false,
      threadError: null,
    };

    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingApproval: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingUserInput: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, threadError: "failed" })).toBe(true);
  });
});

describe("agent browser close confirmation", () => {
  const surfaces = [
    { id: "browser:one", kind: "preview", resourceId: "tab-1" },
    { id: "browser:two", kind: "preview", resourceId: "tab-2" },
    { id: "diff", kind: "diff" },
  ] satisfies RightPanelSurface[];

  it("only warns for browsers under active agent control", () => {
    expect(
      agentControlledBrowserCloseConfirmation(surfaces, {
        "tab-1": { controller: "none" },
        "tab-2": { controller: "human" },
      }),
    ).toBeNull();

    expect(
      agentControlledBrowserCloseConfirmation([surfaces[0]!], {
        "tab-1": { controller: "agent" },
      }),
    ).toBe(
      [
        "Close browser while the agent is using it?",
        "The agent is actively controlling this browser. Closing it may interrupt the current browser action.",
      ].join("\n"),
    );
  });

  it("counts every agent-controlled browser in a bulk close", () => {
    expect(
      agentControlledBrowserCloseConfirmation(surfaces, {
        "tab-1": { controller: "agent" },
        "tab-2": { controller: "agent" },
      }),
    ).toContain("Close 2 browsers");
  });
});

describe("floating browser preview", () => {
  it("only hides the duplicate while the same browser is rendered in the panel", () => {
    expect(shouldRenderPreviewMiniPlayer(null, null)).toBe(false);
    expect(
      shouldRenderPreviewMiniPlayer(
        { kind: "browser", tabId: "tab-1" },
        {
          id: "browser:one",
          kind: "preview",
          resourceId: "tab-1",
        },
      ),
    ).toBe(false);
    expect(
      shouldRenderPreviewMiniPlayer(
        { kind: "browser", tabId: "tab-1" },
        {
          id: "browser:two",
          kind: "preview",
          resourceId: "tab-2",
        },
      ),
    ).toBe(true);
    expect(
      shouldRenderPreviewMiniPlayer(
        { kind: "browser", tabId: "tab-1" },
        { id: "diff", kind: "diff" },
      ),
    ).toBe(true);
  });
});

describe("proactive panels", () => {
  it("opens an existing pull request on entry and follows newly observed links", () => {
    expect(shouldOpenProactivePullRequest(undefined, "project:repo:42")).toBe(true);
    expect(shouldOpenProactivePullRequest(null, "project:repo:42")).toBe(true);
    expect(shouldOpenProactivePullRequest("project:repo:42", "project:repo:42")).toBe(false);
    expect(shouldOpenProactivePullRequest("project:repo:42", null)).toBe(false);
  });

  it("opens a completed diff on entry or when the observed running turn settles", () => {
    const turnId = RunId.make("turn-1");
    expect(
      shouldOpenProactiveTurnDiff({
        previousRunningTurnId: undefined,
        runningTurnId: null,
        settledTurnId: turnId,
        turnCompleted: true,
      }),
    ).toBe(true);
    expect(
      shouldOpenProactiveTurnDiff({
        previousRunningTurnId: turnId,
        runningTurnId: null,
        settledTurnId: turnId,
        turnCompleted: true,
      }),
    ).toBe(true);
    expect(
      shouldOpenProactiveTurnDiff({
        previousRunningTurnId: turnId,
        runningTurnId: RunId.make("turn-2"),
        settledTurnId: turnId,
        turnCompleted: true,
      }),
    ).toBe(false);
    expect(
      shouldOpenProactiveTurnDiff({
        previousRunningTurnId: turnId,
        runningTurnId: null,
        settledTurnId: turnId,
        turnCompleted: false,
      }),
    ).toBe(false);
  });
});

describe("artifact template composer insertion", () => {
  it("does not insert an already-present prompt", () => {
    const prompt = "Create a document using this $artifact-template-hello-world about…";

    expect(codexArtifactTemplatePromptToAppend(prompt, helloWorldTemplate)).toBeNull();
  });
});

describe("draft hero submission transition", () => {
  it("does not dock the composer before a background submission", () => {
    expect(
      shouldDockDraftHeroForSubmission({
        isDraftHeroState: true,
        activeThreadKey: "environment-local:thread-1",
        submissionIntent: "background",
      }),
    ).toBe(false);
  });

  it("leaves the hero layout while a worktree setup card is on the timeline", () => {
    expect(
      resolveDraftHeroState({
        isLocalDraftThread: true,
        hasTimelineEntries: false,
        isWorking: false,
        draftHeroDockRequested: false,
        backgroundSubmissionPending: false,
        hasWorktreeSetupCard: true,
      }),
    ).toBe(false);
    expect(
      resolveDraftHeroState({
        isLocalDraftThread: true,
        hasTimelineEntries: false,
        isWorking: false,
        draftHeroDockRequested: false,
        backgroundSubmissionPending: true,
        hasWorktreeSetupCard: true,
      }),
    ).toBe(false);
  });

  it("keeps the composer in the hero layout until navigation after server promotion", () => {
    expect(
      resolveDraftHeroState({
        isLocalDraftThread: false,
        hasTimelineEntries: true,
        isWorking: true,
        draftHeroDockRequested: false,
        backgroundSubmissionPending: true,
      }),
    ).toBe(true);
  });

  it("does not auto-navigate a background submission after server promotion", () => {
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef: { environmentId, threadId },
        serverThread: makeThread({ latestRun: completedTurn }),
        backgroundSubmissionPending: true,
      }),
    ).toBeNull();
  });
});

describe("resolveThreadSwitchTimeline", () => {
  afterEach(() => {
    resetHeldThreadTimeline();
  });

  const held = { threadKey: "env-1:thread-a", entries: ["a1", "a2"] };

  it("keeps the previous thread's entries while the next thread is loading", () => {
    expect(
      resolveThreadSwitchTimeline({
        loading: true,
        activeThreadKey: "env-1:thread-b",
        nextEntries: [],
        lastReady: held,
      }),
    ).toEqual({ entries: ["a1", "a2"], displayThreadKey: "env-1:thread-a" });
  });

  it("shows the new thread once its detail is ready", () => {
    expect(
      resolveThreadSwitchTimeline({
        loading: false,
        activeThreadKey: "env-1:thread-b",
        nextEntries: ["b1"],
        lastReady: held,
      }),
    ).toEqual({ entries: ["b1"], displayThreadKey: "env-1:thread-b" });
  });

  it("does not invent a timeline on the first open of a thread", () => {
    expect(
      resolveThreadSwitchTimeline({
        loading: true,
        activeThreadKey: "env-1:thread-a",
        nextEntries: [],
        lastReady: null,
      }),
    ).toEqual({ entries: [], displayThreadKey: "env-1:thread-a" });
  });

  it("keeps the held thread workspace cwd with the snapshot", () => {
    rememberReadyThreadTimeline({
      ...held,
      markdownCwd: "/repo/a",
      workspaceRoot: "/repo/a",
    });
    expect(peekHeldThreadTimeline<string[]>()).toEqual({
      ...held,
      markdownCwd: "/repo/a",
      workspaceRoot: "/repo/a",
    });
  });

  it("survives a ChatView remount by remembering the last ready timeline", () => {
    rememberReadyThreadTimeline(held);
    expect(peekHeldThreadTimeline<string[]>()).toEqual(held);
    expect(
      resolveThreadSwitchTimeline({
        loading: true,
        activeThreadKey: "env-1:thread-b",
        nextEntries: [],
      }),
    ).toEqual({ entries: ["a1", "a2"], displayThreadKey: "env-1:thread-a" });
  });

  it("prefers live entries over a remembered snapshot", () => {
    rememberReadyThreadTimeline({ threadKey: "env-1:thread-b", entries: ["stale-b"] });
    expect(
      resolveThreadSwitchTimeline({
        loading: false,
        activeThreadKey: "env-1:thread-b",
        nextEntries: ["fresh-b"],
      }),
    ).toEqual({ entries: ["fresh-b"], displayThreadKey: "env-1:thread-b" });
  });

  it("does not keep a remembered snapshot on a resolved empty thread", () => {
    rememberReadyThreadTimeline(held);
    expect(
      resolveThreadSwitchTimeline({
        loading: false,
        activeThreadKey: "env-1:thread-a",
        nextEntries: [],
      }),
    ).toEqual({ entries: [], displayThreadKey: "env-1:thread-a" });
  });

  it("treats a foreign held timeline as paint-only", () => {
    expect(isPaintOnlyThreadTimeline("env-1:thread-a", "env-1:thread-b")).toBe(true);
    expect(isPaintOnlyThreadTimeline("env-1:thread-b", "env-1:thread-b")).toBe(false);
  });
});

describe("shouldReleaseTimelineAnchorForToolActivity", () => {
  const activeTurnId = RunId.make("active-turn");
  const anchorMessageId = MessageId.make("anchored-message");
  const activeToolEntry = {
    id: "tool-entry",
    kind: "work" as const,
    createdAt: now,
    entry: {
      id: "active-tool",
      createdAt: now,
      runId: activeTurnId,
      label: "Run command",
      tone: "tool" as const,
      command: "git status",
    },
  };

  it("releases the send anchor for tool activity in the active turn", () => {
    expect(
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled: true,
        runningTurnId: activeTurnId,
        timelineEntries: [activeToolEntry],
      }),
    ).toBe(true);
  });

  it("keeps the anchor while the user reads history", () => {
    expect(
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled: false,
        runningTurnId: activeTurnId,
        timelineEntries: [activeToolEntry],
      }),
    ).toBe(false);
  });

  it("ignores tool activity from earlier turns", () => {
    expect(
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled: true,
        runningTurnId: activeTurnId,
        timelineEntries: [
          {
            ...activeToolEntry,
            entry: {
              ...activeToolEntry.entry,
              runId: RunId.make("previous-turn"),
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("ignores thinking and error rows without tool activity", () => {
    expect(
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled: true,
        runningTurnId: activeTurnId,
        timelineEntries: [
          {
            ...activeToolEntry,
            entry: {
              id: "thinking-entry",
              createdAt: now,
              runId: activeTurnId,
              label: "Thinking",
              tone: "thinking",
            },
          },
          {
            ...activeToolEntry,
            id: "error-entry",
            entry: {
              id: "error-entry",
              createdAt: now,
              runId: activeTurnId,
              label: "Provider error",
              tone: "error",
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("does nothing without an anchor or running turn", () => {
    const input = {
      anchorMessageId,
      liveFollowEnabled: true,
      runningTurnId: activeTurnId,
      timelineEntries: [activeToolEntry],
    };

    expect(shouldReleaseTimelineAnchorForToolActivity({ ...input, anchorMessageId: null })).toBe(
      false,
    );
    expect(shouldReleaseTimelineAnchorForToolActivity({ ...input, runningTurnId: null })).toBe(
      false,
    );
  });
});

describe("resolveComposerProviderSelection", () => {
  const catalogModels: ServerProvider["models"] = [
    { slug: "gemini-pro", name: "Gemini Pro", isCustom: false, capabilities: null },
  ];

  function entry(driver: string, instanceId = driver, overrides: Partial<ServerProvider> = {}) {
    return deriveProviderInstanceEntries([
      {
        driver: ProviderDriverKind.make(driver),
        instanceId: ProviderInstanceId.make(instanceId),
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        version: null,
        checkedAt: now,
        models: [],
        slashCommands: [],
        skills: [],
        ...overrides,
      },
    ])[0]!;
  }

  function importedThread(instanceId: ProviderInstanceId) {
    return makeThread({
      modelSelection: { instanceId, model: "default" },
      itemCount: 1,
    });
  }

  it("leaves a new draft free to select a different driver", () => {
    const original = entry("claudeAgent", "claude_work");
    const selected = entry("codex", "codex_work");
    expect(
      deriveLockedProvider({
        thread: makeThread({
          modelSelection: { instanceId: original.instanceId, model: "default" },
        }),
        selectedProvider: selected.instanceId,
        threadProvider: original.instanceId,
        providers: [original.snapshot, selected.snapshot],
      }),
    ).toBeNull();
  });

  it("uses the custom instance's capability instead of the default instance", () => {
    const defaultEntry = entry("antigravity", "antigravity", {
      showInteractionModeToggle: true,
    });
    const customEntry = entry("antigravity", "google_work", {
      showInteractionModeToggle: false,
    });
    const selection = resolveComposerProviderSelection({
      entries: [defaultEntry, customEntry],
      candidateInstanceIds: [customEntry.instanceId],
      lockedProvider: null,
      lockedInstanceId: null,
    });

    expect(selection.selectedProviderEntry?.instanceId).toBe(customEntry.instanceId);
    expect(
      resolveComposerInteractionMode({
        provider: selection.selectedProviderEntry?.snapshot,
        planModeEnabled: true,
        interactionMode: "plan",
      }),
    ).toEqual({ enabled: false, interactionMode: "default" });
  });

  it("uses the fallback provider's plan capability after the draft's instance is disabled", () => {
    const disabledEntry = entry("antigravity", "antigravity", {
      enabled: false,
      showInteractionModeToggle: false,
    });
    const fallbackEntry = entry("codex");
    const selection = resolveComposerProviderSelection({
      entries: [disabledEntry, fallbackEntry],
      candidateInstanceIds: [disabledEntry.instanceId],
      lockedProvider: null,
      lockedInstanceId: null,
    });

    expect(selection.selectedProviderEntry?.instanceId).toBe(fallbackEntry.instanceId);
    expect(
      resolveComposerInteractionMode({
        provider: selection.selectedProviderEntry?.snapshot,
        planModeEnabled: true,
        interactionMode: "plan",
      }),
    ).toEqual({ enabled: true, interactionMode: "plan" });
  });

  it("blocks sends until the selected Antigravity profile is installed", () => {
    const provider = entry("antigravity", "google_work", {
      installed: false,
      models: catalogModels,
    }).snapshot;

    expect(getAntigravitySendBlockReason(provider, "gemini-pro")).toBe(
      "Install Antigravity in provider settings before sending.",
    );
  });

  it("lets Antigravity check saved credentials when resuming after a restart", () => {
    const provider = entry("antigravity", "google_work", {
      status: "warning",
      auth: { status: "unknown" },
      models: [],
    }).snapshot;

    expect(getAntigravitySendBlockReason(provider, "gemini-pro")).toBeNull();
    expect(getAntigravitySendBlockReason(provider, ANTIGRAVITY_DEFAULT_MODEL)).toBeNull();
    expect(
      getAntigravitySendBlockReason({ ...provider, models: catalogModels }, "gemini-pro"),
    ).toBeNull();
    expect(getAntigravitySendBlockReason(provider, "")).toBe(
      "Choose an Antigravity model before sending.",
    );
  });

  it("blocks saved model sends until Antigravity loads its account catalog", () => {
    expect(getAntigravitySendBlockReason(entry("antigravity").snapshot, "gemini-pro")).toBe(
      "Refresh Antigravity models in provider settings before sending.",
    );
  });

  it("blocks an empty Antigravity selection after the catalog has loaded", () => {
    const provider = entry("antigravity", "google_work", { models: catalogModels }).snapshot;

    expect(getAntigravitySendBlockReason(provider, "")).toBe(
      "Choose an Antigravity model before sending.",
    );
  });

  it("keeps existing send behavior for other providers", () => {
    const provider = entry("codex", "codex", {
      installed: false,
      auth: { status: "unknown" },
      models: [],
    }).snapshot;

    expect(getAntigravitySendBlockReason(provider, "gpt-model")).toBeNull();
  });

  it("does not treat the empty draft placeholder as a provider setup target", () => {
    const selection = resolveComposerProviderSelection({
      entries: [entry("antigravity", "antigravity", { enabled: false })],
      candidateInstanceIds: [NO_PROVIDER_MODEL_SELECTION.instanceId],
      lockedProvider: null,
      lockedInstanceId: null,
    });

    expect(selection.selectedProviderEntry).toBeUndefined();
    expect(selection.unavailableProviderInstanceId).toBeUndefined();
  });
});

describe("resolveComposerInteractionMode", () => {
  it("resets a restored plan draft when the selected instance does not support plan mode", () => {
    expect(
      resolveComposerInteractionMode({
        planModeEnabled: true,
        provider: { showInteractionModeToggle: false },
        interactionMode: "plan",
      }),
    ).toEqual({ enabled: false, interactionMode: "default" });
  });

  it("keeps legacy plan behavior for providers that omit the capability", () => {
    expect(
      resolveComposerInteractionMode({
        planModeEnabled: true,
        provider: {},
        interactionMode: "plan",
      }),
    ).toEqual({ enabled: true, interactionMode: "plan" });
  });

  it("resets a restored plan draft when the beta setting is off", () => {
    expect(
      resolveComposerInteractionMode({
        planModeEnabled: false,
        provider: { showInteractionModeToggle: true },
        interactionMode: "plan",
      }),
    ).toEqual({ enabled: false, interactionMode: "default" });
  });

  it("disables plan mode until the selected provider is available", () => {
    expect(
      resolveComposerInteractionMode({
        planModeEnabled: true,
        provider: null,
        interactionMode: "plan",
      }),
    ).toEqual({ enabled: false, interactionMode: "default" });
  });
});

describe("resolveBackgroundDraftWorkspaceOptions", () => {
  it("keeps New worktree selected without reusing the launched worktree", () => {
    expect(
      resolveBackgroundDraftWorkspaceOptions({
        envMode: "worktree",
        branch: "main",
        startFromOrigin: true,
      }),
    ).toEqual({
      envMode: "worktree",
      branch: "main",
      worktreePath: null,
      startFromOrigin: true,
    });
  });
});

describe("proactive completed diff guard", () => {
  it.each([
    { files: 0, additions: 0, deletions: 0, action: "ignore" },
    { files: 1, additions: 1, deletions: 0, action: "ignore" },
    { files: 2, additions: 12, deletions: 12, action: "ignore" },
    { files: 1, additions: 25, deletions: 24, action: "ignore" },
    { files: 1, additions: 25, deletions: 25, action: "open" },
    { files: 1, additions: 0, deletions: 50, action: "open" },
    { files: 3, additions: 1, deletions: 0, action: "open" },
  ])(
    "uses change size for automatic diffs: $files files, +$additions/-$deletions",
    ({ files, additions, deletions, action }) => {
      const changedCheckpoint = {
        status: "ready",
        files: Array.from({ length: files }, (_, index) => ({
          path: `src/app-${index}.ts`,
          kind: "modified" as const,
          additions,
          deletions,
        })),
      } satisfies Pick<TurnDiffSummary, "status" | "files">;

      expect(
        resolveProactiveTurnDiffAction({
          checkpoint: changedCheckpoint,
          isGitRepo: true,
        }),
      ).toBe(action);
    },
  );

  it("waits for definitive checkpoint and repository state", () => {
    const missingCheckpoint = {
      status: "missing",
      files: [],
    } satisfies Pick<TurnDiffSummary, "status" | "files">;
    const changedCheckpoint = {
      status: "ready",
      files: [{ path: "src/app.ts", kind: "modified", additions: 1, deletions: 0 }],
    } satisfies Pick<TurnDiffSummary, "status" | "files">;

    expect(
      resolveProactiveTurnDiffAction({
        checkpoint: undefined,
        isGitRepo: true,
      }),
    ).toBe("defer");
    expect(
      resolveProactiveTurnDiffAction({
        checkpoint: missingCheckpoint,
        isGitRepo: true,
      }),
    ).toBe("defer");
    expect(
      resolveProactiveTurnDiffAction({
        checkpoint: changedCheckpoint,
        isGitRepo: undefined,
      }),
    ).toBe("defer");
  });

  it.each(["pull-requests", "diff"] as const)(
    "keeps an active %s above a completed turn diff",
    (kind) => {
      const ref = { environmentId, threadId: ThreadId.make(`proactive-${kind}`) };
      const store = useRightPanelStore.getState();
      store.open(ref, kind);
      const revision = store.getUserActionRevision(ref);
      expect(
        store.openProactive(ref, { kind: "diff", turnId: RunId.make("completed-run") }, revision),
      ).toBe(false);
      expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, ref)).toBe(kind);
    },
  );
});

describe("shouldRefocusComposerOnWindowFocus", () => {
  function element(
    tagName: string,
    options?: { editable?: boolean; role?: string; within?: string },
  ) {
    return {
      tagName,
      isContentEditable: options?.editable ?? false,
      getAttribute: (name: string) => (name === "role" ? (options?.role ?? null) : null),
      closest: (selector: string) =>
        options?.within !== undefined && selector.includes(options.within) ? ({} as Element) : null,
    };
  }

  it("refocuses when nothing or the body holds focus", () => {
    expect(shouldRefocusComposerOnWindowFocus(null)).toBe(true);
    expect(shouldRefocusComposerOnWindowFocus(element("BODY"))).toBe(true);
  });

  it("refocuses away from a plain button, such as a pull request tab", () => {
    expect(shouldRefocusComposerOnWindowFocus(element("BUTTON"))).toBe(true);
  });

  it("leaves other text fields alone", () => {
    expect(shouldRefocusComposerOnWindowFocus(element("INPUT"))).toBe(false);
    expect(shouldRefocusComposerOnWindowFocus(element("TEXTAREA"))).toBe(false);
    expect(shouldRefocusComposerOnWindowFocus(element("DIV", { editable: true }))).toBe(false);
    expect(shouldRefocusComposerOnWindowFocus(element("DIV", { role: "textbox" }))).toBe(false);
  });

  it.each(["IFRAME", "WEBVIEW"])("leaves a focused %s preview alone", (tagName) => {
    expect(shouldRefocusComposerOnWindowFocus(element(tagName))).toBe(false);
  });

  it("leaves a focused terminal alone in the drawer and the right panel", () => {
    expect(
      shouldRefocusComposerOnWindowFocus(element("BUTTON", { within: "data-terminal-owner" })),
    ).toBe(false);
  });

  it("leaves focus inside a dialog or popup alone", () => {
    expect(shouldRefocusComposerOnWindowFocus(element("BUTTON", { within: "dialog" }))).toBe(false);
    expect(shouldRefocusComposerOnWindowFocus(element("BUTTON", { within: "-popup" }))).toBe(false);
  });
});

describe("checkout Git memory", () => {
  it("answers from the last status seen for the same checkout", () => {
    rememberCheckoutIsRepo(environmentId, "/repo/plain-folder", false);
    expect(recallCheckoutIsRepo(environmentId, "/repo/plain-folder")).toBe(false);
    rememberCheckoutIsRepo(environmentId, "/repo/plain-folder", true);
    expect(recallCheckoutIsRepo(environmentId, "/repo/plain-folder")).toBe(true);
  });

  it("does not answer for a checkout it has not seen", () => {
    expect(recallCheckoutIsRepo(environmentId, "/repo/never-opened")).toBeUndefined();
    expect(recallCheckoutIsRepo(environmentId, null)).toBeUndefined();
  });

  it("keeps environments apart", () => {
    rememberCheckoutIsRepo(environmentId, "/repo/shared-path", false);
    expect(
      recallCheckoutIsRepo(EnvironmentId.make("env-other"), "/repo/shared-path"),
    ).toBeUndefined();
  });
});

describe("threadShellHasStarted", () => {
  it("counts a thread that has a user message but no latest turn", () => {
    expect(
      threadShellHasStarted({ latestRun: null, latestUserMessageAt: now, runtime: null }),
    ).toBe(true);
  });

  it("counts a thread with a live runtime and nothing else", () => {
    expect(
      threadShellHasStarted({
        latestRun: null,
        latestUserMessageAt: null,
        runtime: {
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "starting",
          providerName: "codex",
          activeRunId: null,
          lastError: null,
          updatedAt: now,
        },
      }),
    ).toBe(true);
  });

  it("does not count a thread that never sent anything", () => {
    expect(
      threadShellHasStarted({ latestRun: null, latestUserMessageAt: null, runtime: null }),
    ).toBe(false);
    expect(threadShellHasStarted(null)).toBe(false);
  });
});

it("follows a changed server PR link without replacing an unrelated open panel", () => {
  const previous = {
    projectId: ProjectId.make("project-1"),
    repository: "pingdotgg/t3code",
    number: 42,
    url: "https://github.com/pingdotgg/t3code/pull/42",
  };
  const current = {
    ...previous,
    number: 43,
    url: "https://github.com/pingdotgg/t3code/pull/43",
  };
  const surface = {
    id: "pull-request:previous",
    kind: "pull-request",
    projectId: previous.projectId,
    repository: "PingDotGG/T3Code",
    number: previous.number,
  } satisfies RightPanelSurface;

  expect(shouldRetargetThreadPullRequestPanel(previous, current, surface)).toBe(true);
  expect(shouldRetargetThreadPullRequestPanel(previous, previous, surface)).toBe(false);
  expect(shouldRetargetThreadPullRequestPanel(previous, null, surface)).toBe(false);
  expect(shouldRetargetThreadPullRequestPanel(previous, current, { ...surface, number: 99 })).toBe(
    false,
  );
  expect(
    shouldRetargetThreadPullRequestPanel(previous, current, {
      ...surface,
      projectId: "another-project",
    }),
  ).toBe(false);
});

describe("worktree setup visibility", () => {
  const stage = (
    id: "fetch" | "checkout" | "submodules" | "setup-script" | "agent",
    status: "done" | "running" | "failed" | "pending",
  ) => ({
    id,
    status,
    startedAt: now,
    endedAt: status === "running" || status === "pending" ? null : now,
    percent: null,
    detail: null,
    tail: [],
  });
  const base = {
    threadId,
    phase: "running" as const,
    startedAt: now,
    endedAt: null,
    branch: "feature",
    baseRef: "main",
    worktreePath: null,
    setupScript: null,
    stages: [stage("checkout", "running"), stage("agent", "pending")],
    error: null,
    sequence: 1,
  };
  const settledDone = {
    ...base,
    phase: "done" as const,
    endedAt: now,
    stages: [stage("checkout", "done"), stage("setup-script", "done"), stage("agent", "done")],
  };

  it("keeps setup presentation continuous until the provider handoff", () => {
    const progress = (
      localPreparing: boolean,
      runStatus: NonNullable<Thread["latestRun"]>["status"] | undefined,
      latest: WorktreeSetupSnapshot | null,
      held: WorktreeSetupSnapshot | null = null,
    ) => resolveWorktreeSetupProgress({ threadId, localPreparing, runStatus, latest, held });

    expect(progress(true, undefined, null).isPreparingWorktree).toBe(true);
    expect(progress(false, "preparing", null).isPreparingWorktree).toBe(true);
    expect(progress(false, "preparing", base).snapshot).toBe(base);
    expect(progress(false, "starting", base).isPreparingWorktree).toBe(true);
    const handedOff = {
      ...base,
      sequence: 2,
      stages: [stage("setup-script", "running"), stage("agent", "done")],
    };
    expect(progress(false, "starting", handedOff, base)).toEqual({
      snapshot: handedOff,
      isPreparingWorktree: false,
    });
    expect(progress(false, "running", null, handedOff).snapshot).toBe(handedOff);
  });

  it.each(["failed", "cancelled"] as const)(
    "does not keep %s setup in the preparing state",
    (phase) => {
      const snapshot = { ...base, phase };
      expect(
        resolveWorktreeSetupProgress({
          threadId,
          localPreparing: false,
          runStatus: "failed",
          latest: snapshot,
          held: base,
        }),
      ).toEqual({ snapshot, isPreparingWorktree: false });
    },
  );

  it("shows a running setup and drops a clean one once the turn started", () => {
    const visible = (snapshot: WorktreeSetupSnapshot | null, turnStarted: boolean) =>
      resolveVisibleWorktreeSetup({
        live: null,
        recorded: snapshot,
        turnStarted,
        followUpSent: false,
      });
    expect(
      resolveVisibleWorktreeSetup({
        live: base,
        recorded: null,
        turnStarted: false,
        followUpSent: false,
      }),
    ).toEqual(base);
    expect(visible(settledDone, false)).toEqual(settledDone);
    expect(visible(settledDone, true)).toBeNull();
    expect(visible(null, true)).toBeNull();
  });

  it("keeps a failed script, a failed setup, and a cancelled setup visible", () => {
    const scriptFailed = {
      ...settledDone,
      stages: [stage("checkout", "done"), stage("setup-script", "failed"), stage("agent", "done")],
    };
    const visible = (snapshot: WorktreeSetupSnapshot, followUpSent = false) =>
      resolveVisibleWorktreeSetup({
        live: null,
        recorded: snapshot,
        turnStarted: true,
        followUpSent,
      });
    expect(visible(scriptFailed)).toEqual(scriptFailed);
    const failed = { ...settledDone, phase: "failed" as const, error: "git exploded" };
    expect(visible(failed)).toEqual(failed);
    const cancelled = { ...settledDone, phase: "cancelled" as const };
    expect(visible(cancelled)).toEqual(cancelled);

    expect(visible(scriptFailed, true)).toBeNull();
    expect(visible(failed, true)).toBeNull();
    expect(visible(cancelled, true)).toBeNull();
    expect(visible(settledDone, true)).toBeNull();
    const stillRunning = {
      ...base,
      stages: [stage("checkout", "done"), stage("setup-script", "running"), stage("agent", "done")],
    };
    expect(visible(stillRunning, true)).toEqual(stillRunning);
  });

  it("prefers whichever snapshot is newer by sequence", () => {
    const pick = (live: WorktreeSetupSnapshot | null, recorded: WorktreeSetupSnapshot | null) =>
      resolveVisibleWorktreeSetup({ live, recorded, turnStarted: false, followUpSent: false });
    expect(pick({ ...base, sequence: 3 }, { ...settledDone, sequence: 7 })).toEqual({
      ...settledDone,
      sequence: 7,
    });
    expect(pick({ ...settledDone, sequence: 9 }, { ...base, sequence: 1 })).toEqual({
      ...settledDone,
      sequence: 9,
    });
  });
});

describe("waitForRevertedMessage", () => {
  const threadRef = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("t") };
  const messageId = MessageId.make("message-2");
  const requestId = CommandId.make("rollback-1");

  function projectionAtom() {
    const base = makeThreadProjectionFixture();
    const projection = {
      ...base,
      runs: [{ id: RunId.make("run-2"), ordinal: 2, status: "completed" }],
      messages: [
        {
          id: messageId,
          threadId: base.thread.id,
          runId: RunId.make("run-2"),
          nodeId: null,
          role: "user",
          text: "second",
          attachments: [],
          streaming: false,
          createdAt: base.updatedAt,
          updatedAt: base.updatedAt,
        },
      ],
    } as unknown as ReturnType<typeof makeThreadProjectionFixture>;
    const state = Atom.make({ data: Option.some(projection) });
    vi.spyOn(environmentThreadDetails, "stateAtom").mockReturnValue(state as never);
    return { state, projection };
  }

  afterEach(() => vi.restoreAllMocks());

  it("rejects with the projected reason when the rollback fails for good", async () => {
    const { state, projection } = projectionAtom();
    const waiting = waitForRevertedMessage(threadRef, 1, requestId, async () => {});
    await Promise.resolve();
    appAtomRegistry.set(state, {
      data: Option.some({
        ...projection,
        thread: {
          ...projection.thread,
          rollbackFailure: { requestId, message: "The provider could not roll back." },
        },
      }),
    });

    await expect(waiting).rejects.toThrow("The provider could not roll back.");
  });

  it("ignores a failure recorded for an earlier rollback", async () => {
    vi.useFakeTimers();
    const { state, projection } = projectionAtom();
    const waiting = waitForRevertedMessage(threadRef, 1, requestId, async () => {}, 50);
    const settled = expect(waiting).rejects.toThrow("Timed out waiting for the thread to rewind.");
    appAtomRegistry.set(state, {
      data: Option.some({
        ...projection,
        thread: {
          ...projection.thread,
          rollbackFailure: { requestId: CommandId.make("rollback-0"), message: "Old failure." },
        },
      }),
    });
    await vi.advanceTimersByTimeAsync(50);
    await settled;
    vi.useRealTimers();
  });
});

describe("DiffPanel ownership", () => {
  it.each([
    ["closed", false, "diff", false],
    ["open", true, "diff", true],
    ["closed again", false, "diff", false],
  ] as const)(
    "is %s when panel open is %s and the active surface is %s",
    (_phase, rightPanelOpen, activeSurfaceKind, expected) => {
      expect(shouldMountDiffPanel({ rightPanelOpen, activeSurfaceKind })).toBe(expected);
    },
  );
});

describe("diff worker pool ownership", () => {
  it.each([
    [0, [], false],
    [1, [], true],
    [0, ["diff"], true],
    [0, ["pull-request"], true],
    [0, ["terminal", "preview"], false],
  ] as const)("resolves %i summaries and %j surfaces", (turnDiffSummaryCount, kinds, expected) => {
    expect(
      shouldMountDiffWorkerPool({
        turnDiffSummaryCount,
        rightPanelSurfaceKinds: kinds,
      }),
    ).toBe(expected);
  });
});

describe("uncertain send acknowledgement", () => {
  it("waits for acknowledgement and clears only the restored draft", () => {
    const messageId = MessageId.make("uncertain-send");
    const restoredDraft = { prompt: "send this" };
    const input = { messageId, restoredDraft, currentDraft: restoredDraft };
    expect(resolveUncertainSendRecovery({ ...input, serverMessageIds: [] })).toBe("waiting");
    expect(resolveUncertainSendRecovery({ ...input, serverMessageIds: [messageId] })).toBe("clear");
    expect(
      resolveUncertainSendRecovery({
        ...input,
        serverMessageIds: [messageId],
        currentDraft: { prompt: "new work" },
      }),
    ).toBe("preserve");
  });
});
