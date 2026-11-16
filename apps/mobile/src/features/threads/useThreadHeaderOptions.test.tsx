import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// Native header item factories are only read when options are applied, so the fake
// navigation snapshots the right items at each setOptions, as native-stack does.
const harness = vi.hoisted(() => ({
  setOptionsCalls: 0,
  renderedRightItems: [] as Array<ReadonlyArray<Record<string, unknown>>>,
  navigatedRoutes: [] as string[],
}));

vi.mock("@react-navigation/native", async () => {
  const { createContext } = await import("react");
  const navigation = {
    getState: () => ({ routes: [{ key: "thread-route", name: "Thread" }] }),
    canGoBack: () => true,
    dispatch: () => {},
    goBack: () => {},
    navigate: (route: string) => {
      harness.navigatedRoutes.push(route);
    },
    addListener: () => () => {},
    setOptions: (options: { unstable_headerRightItems?: () => Array<Record<string, unknown>> }) => {
      harness.setOptionsCalls += 1;
      harness.renderedRightItems.push(options.unstable_headerRightItems?.() ?? []);
    },
  };
  return {
    StackActions: { replace: () => ({}) },
    useNavigation: () => navigation,
    useRoute: () => ({ key: "thread-route", name: "Thread" }),
    NavigationContext: createContext(navigation),
    NavigationRouteContext: createContext({ key: "thread-route" }),
  };
});
vi.mock("../workspace/WorkspaceTabsContext", () => ({ useWorkspaceTabs: () => null }));
vi.mock("../layout/useSidebarToggle", () => ({ useSidebarToggle: () => null }));
vi.mock("../../native/native-layout-metrics", () => ({ useDeviceType: () => "phone" }));
vi.mock("../../native/useOpenPullRequest", () => ({ useOpenPullRequest: () => () => {} }));

vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("expo-glass-effect", () => ({ GlassContainer: "div" }));
vi.mock("../../native/NativeWorkspaceColumns", () => ({
  useNativeWorkspaceColumnsSupported: () => false,
}));
vi.mock("../../native/use-native-mail-search-toolbar", () => ({
  useNativeMailSearchToolbar: () => false,
}));
vi.mock("../../components/ui/useControlTheme", () => ({ useControlTheme: () => ({ colors: {} }) }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ confirm: () => {} }));
vi.mock("../../components/ui/ScreenHeaderButton", () => ({ ScreenHeaderButton: () => null }));
vi.mock("react-native", () => ({ Alert: { alert: () => {} }, Linking: {}, Platform: {} }));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useWorkspacePaneState: () => ({ panes: { auxiliaryPaneVisible: false } }),
  useAdaptiveWorkspaceLayout: () => ({
    layout: { usesSplitView: false },
    panes: { primarySidebarVisible: false, auxiliaryPaneVisible: false },
    togglePrimarySidebar: () => {},
    toggleAuxiliaryPane: () => {},
    startNewTask: () => {},
  }),
}));
vi.mock("../layout/native-mail-search-toolbar", () => ({
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED: true,
  createNativeMailSearchToolbarItem: () => ({}),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));

import { ThreadHeader } from "./ThreadHeader";
import { threadTerminalMenu, type ThreadGitControlsProps } from "./ThreadGitControls";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";

const projectScripts: never[] = [];

function status(
  files: ReadonlyArray<string>,
  overrides: Partial<VcsStatusResult> = {},
): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: true,
    refName: "master",
    hasWorkingTreeChanges: files.length > 0,
    workingTree: {
      files: files.map((path) => ({ path, insertions: 0, deletions: 0 })),
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  } as unknown as VcsStatusResult;
}

function Header(props: { readonly gitStatus: VcsStatusResult | null; readonly title?: string }) {
  return (
    <ThreadHeader
      title={props.title ?? "Thread"}
      subtitle=""
      gitControls={{
        environmentId: "environment-1",
        threadId: "thread-1",
        currentBranch: "master",
        gitCwd: "/workspace",
        gitStatus: props.gitStatus,
        gitOperationLabel: null,
        onPull: async () => {},
        onRunAction: async () => null,
        canOpenTerminal: true,
        canOperateTerminal: true,
        canOpenFiles: true,
        projectScripts,
        terminalSessions: [],
        onOpenTerminal: () => {},
        onOpenNewTerminal: () => {},
        onRunProjectScript: async () => {},
      }}
      hasThreadCwd
      inspectorMode={null}
      onOpenFilesInspector={() => {}}
    />
  );
}

function renderedGitMenuItems(): Array<{
  description?: unknown;
  label?: unknown;
  onPress?: () => void;
}> {
  const items = harness.renderedRightItems.at(-1) ?? [];
  const git = items.find((item) => item.label === "Git controls") as
    | { menu: { items: Array<{ description?: unknown; label?: unknown; onPress?: () => void }> } }
    | undefined;
  return git?.menu.items ?? [];
}

function renderedGitStatusDescription(): unknown {
  return renderedGitMenuItems()[0]?.description;
}

let root: Root | null = null;

function render(element: React.ReactElement) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root ??= createRoot(document.createElement("div"));
  act(() => root!.render(element));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  harness.setOptionsCalls = 0;
  harness.renderedRightItems = [];
  harness.navigatedRoutes = [];
});

describe("ThreadHeader", () => {
  it("re-applies native header items when Git status changes", () => {
    render(<Header gitStatus={status([])} />);
    expect(renderedGitStatusDescription()).toBe("Clean");

    render(<Header gitStatus={status(["audit.txt"])} />);
    expect(renderedGitStatusDescription()).toBe("1 changed");

    render(<Header gitStatus={status([])} />);
    expect(renderedGitStatusDescription()).toBe("Clean");
  });

  it("does not re-apply options for re-renders with equivalent header content", () => {
    render(<Header gitStatus={status([])} />);
    const applied = harness.setOptionsCalls;

    for (let index = 0; index < 20; index += 1) {
      render(<Header gitStatus={status([])} />);
    }
    expect(harness.setOptionsCalls).toBe(applied);
  });

  it("re-applies menu actions when the default ref changes behind the same label", async () => {
    const pushable = (isDefaultRef: boolean) =>
      status([], {
        isDefaultRef,
        aheadCount: 1,
        hasPrimaryRemote: true,
        pr: { state: "open", url: "https://example.com/pr/1" },
      } as Partial<VcsStatusResult>);
    render(<Header gitStatus={pushable(false)} />);
    expect(renderedGitMenuItems()[1]?.label).toBe("Push");

    render(<Header gitStatus={pushable(true)} />);
    expect(renderedGitMenuItems()[1]?.label).toBe("Push");
    await act(async () => renderedGitMenuItems()[1]?.onPress?.());
    expect(harness.navigatedRoutes).toEqual(["GitConfirm"]);
  });
});

it("keeps resource checkout ownership and actions in the terminal menu", () => {
  const script = {
    id: "sandbox",
    name: "SANDBOX",
    command: "deploy",
    icon: "play" as const,
    runOnWorktreeCreate: false,
    resource: { color: "#3b82f6", checkoutPrompt: "", releaseCommand: "", releasePrompt: "" },
  };
  const onRunProjectScript = vi.fn(async () => {});
  const props: ThreadGitControlsProps = {
    environmentId: "local",
    threadId: "thread-1",
    currentBranch: "main",
    gitCwd: "/workspace",
    gitStatus: null,
    gitOperationLabel: null,
    onPull: async () => {},
    onRunAction: async () => null,
    canOpenTerminal: true,
    canOperateTerminal: true,
    canOpenFiles: true,
    projectScripts: [script],
    terminalSessions: [],
    onOpenTerminal: () => {},
    onOpenNewTerminal: () => {},
    onRunProjectScript,
  };
  const project = {
    environmentId: EnvironmentId.make("local"),
    id: ProjectId.make("project-1"),
  } as EnvironmentProject;
  const lock = {
    script,
    threadId: ThreadId.make("thread-1"),
    operationId: CommandId.make("op"),
    phase: "held" as const,
  };
  const checkout = threadTerminalMenu(props)?.items[0];
  expect(checkout?.title).toBe("Check out SANDBOX");
  if (checkout && "onPress" in checkout) checkout.onPress?.();
  expect(onRunProjectScript).toHaveBeenCalledWith(script);
  expect(
    threadTerminalMenu({ ...props, resourceLocks: [{ project, lock }] })?.items[0]?.title,
  ).toBe("Release SANDBOX");
  expect(
    threadTerminalMenu({ ...props, threadId: "thread-2", resourceLocks: [{ project, lock }] })
      ?.items[0]?.title,
  ).toBe("Take over SANDBOX");
});
