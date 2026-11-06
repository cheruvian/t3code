import { act, create } from "react-test-renderer";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  stopSession: vi.fn(),
  updateMetadata: vi.fn(),
  setDraftContext: vi.fn(),
  refName: "main",
  thread: {
    id: "thread-1",
    environmentId: "env-1",
    projectId: "project-1",
    branch: "feature/task",
    worktreePath: "/repo-worktrees/task",
    session: { status: "ready" },
  },
}));

vi.mock("../state/entities", () => ({
  useThreadShell: () => state.thread,
  useQuietThreadShell: () => state.thread,
  useProject: () => ({ id: "project-1", environmentId: "env-1", workspaceRoot: "/repo" }),
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: unknown) => unknown) =>
    select({ getDraftThreadByRef: () => null, setDraftThreadContext: state.setDraftContext }),
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (_command: unknown, label: unknown) =>
    label === "thread session stop" ? state.stopSession : state.updateMetadata,
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { refName: state.refName, workingTree: { rootPath: "/repo" } },
    isPending: false,
  }),
}));
vi.mock("../state/queries", () => ({
  usePaginatedBranches: () => ({ refs: [], data: null, isPending: false }),
}));
vi.mock("~/hooks/useSupportsMultiplePullRequests", () => ({
  useSupportsMultiplePullRequests: () => false,
}));
vi.mock("../lib/openPullRequestLink", () => ({ useOpenPrLink: () => vi.fn() }));
vi.mock("./ThreadStatusIndicators", () => ({
  useLinkedThreadPullRequest: () => null,
  prStatusIndicator: () => null,
  resolveThreadPullRequestBadge: () => null,
  ThreadPullRequestBadgeControl: () => null,
}));
// Keep the real selector and its effects; the popup's DOM is irrelevant to metadata persistence.
vi.mock("./ui/combobox", () => ({
  Combobox: () => null,
  ComboboxEmpty: () => null,
  ComboboxSearchInput: () => null,
  ComboboxItem: () => null,
  ComboboxListVirtualized: () => null,
  ComboboxPopup: () => null,
  ComboboxStatus: () => null,
  ComboboxTrigger: () => null,
}));

import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";

it("preserves an established worktree and provider session when branch status refreshes", async () => {
  state.refName = "main";
  vi.clearAllMocks();
  const renderSelector = () => (
    <BranchToolbarBranchSelector
      environmentId={EnvironmentId.make("env-1")}
      threadId={ThreadId.make("thread-1")}
      envLocked
      startFromOrigin
      onStartFromOriginChange={() => {}}
    />
  );
  let screen!: ReturnType<typeof create>;
  await act(() => {
    screen = create(renderSelector());
  });
  using _screen = {
    [Symbol.dispose]: () => {
      act(() => screen.unmount());
    },
  };
  state.refName = "feature/task";
  await act(() => screen.update(renderSelector()));
  expect(state.stopSession).not.toHaveBeenCalled();
  expect(state.updateMetadata).not.toHaveBeenCalled();
  expect(state.setDraftContext).not.toHaveBeenCalled();
});
