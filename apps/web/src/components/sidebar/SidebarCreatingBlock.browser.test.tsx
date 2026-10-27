import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";
import { render, act } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { SidebarDraftBlock } from "./SidebarDraftBlock";
import { SidebarCreatingBlock } from "./SidebarCreatingBlock";
import {
  useOptimisticThreadListStore,
  withOptimisticThreadCreation,
} from "../../optimisticThreadListStore";

it("shows creation during dispatch, applies scope, and yields to the server shell", async () => {
  useOptimisticThreadListStore.setState({ entriesByKey: {} });
  const threadRef = scopeThreadRef(EnvironmentId.make("creating"), ThreadId.make("first"));
  const entry = {
    threadRef,
    projectId: ProjectId.make("project"),
    title: "Inspect worker",
    createdAt: "2026-10-27T00:00:00Z",
    draftId: null,
  };
  const onNavigate = vi.fn();
  await using screen = await render(
    <ul>
      <SidebarCreatingBlock
        canonicalThreadKeys={new Set()}
        scopedProjectKeys={null}
        onNavigate={onNavigate}
      />
    </ul>,
  );
  let resolve!: (value: { _tag: "Success" }) => void;
  const pending = new Promise<{ _tag: "Success" }>((done) => {
    resolve = done;
  });
  let dispatch!: Promise<{ _tag: "Success" }>;
  try {
    await act(() => {
      dispatch = withOptimisticThreadCreation(entry, () => pending);
    });
    await expect
      .element(screen.getByRole("button", { name: "Creating thread: Inspect worker" }))
      .toBeVisible();
    await screen.getByRole("button", { name: "Creating thread: Inspect worker" }).click();
    expect(onNavigate).toHaveBeenCalledWith(threadRef);
    await screen.rerender(
      <ul>
        <SidebarCreatingBlock
          canonicalThreadKeys={new Set()}
          scopedProjectKeys={new Set(["other:project"])}
          onNavigate={onNavigate}
        />
      </ul>,
    );
    await expect.element(screen.getByRole("button")).not.toBeInTheDocument();
    await screen.rerender(
      <ul>
        <SidebarCreatingBlock
          canonicalThreadKeys={new Set([scopedThreadKey(threadRef)])}
          scopedProjectKeys={null}
          onNavigate={onNavigate}
        />
      </ul>,
    );
    await expect.element(screen.getByRole("button")).not.toBeInTheDocument();
  } finally {
    resolve({ _tag: "Success" });
    await dispatch;
    useOptimisticThreadListStore.setState({ entriesByKey: {} });
  }
});

it("removes a failed dispatch so its restored draft can own the list again", async () => {
  useOptimisticThreadListStore.setState({ entriesByKey: {} });
  const threadRef = scopeThreadRef(EnvironmentId.make("creating"), ThreadId.make("failed"));
  await using screen = await render(
    <ul>
      <SidebarCreatingBlock
        canonicalThreadKeys={new Set()}
        scopedProjectKeys={null}
        onNavigate={() => {}}
      />
    </ul>,
  );
  try {
    await act(async () => {
      await withOptimisticThreadCreation(
        {
          threadRef,
          projectId: ProjectId.make("project"),
          title: "Failed",
          createdAt: "2026-10-27T00:00:00Z",
          draftId: null,
        },
        async () => ({ _tag: "Failure" }),
      );
    });
    expect(useOptimisticThreadListStore.getState().entriesByKey).toEqual({});
    await expect.element(screen.getByRole("button")).not.toBeInTheDocument();
  } finally {
    useOptimisticThreadListStore.setState({ entriesByKey: {} });
  }
});

function DraftAndCreationRows(props: { draftId: DraftId }) {
  const entries = useOptimisticThreadListStore((state) => state.entriesByKey);
  const creatingDraftIds = new Set(
    Object.values(entries).flatMap((entry) => (entry.draftId ? [entry.draftId] : [])),
  );
  return (
    <ul>
      <SidebarCreatingBlock
        canonicalThreadKeys={new Set()}
        scopedProjectKeys={null}
        onNavigate={() => {}}
      />
      <SidebarDraftBlock
        projectByKey={new Map()}
        projectDisplayNameByKey={new Map()}
        scopedProjectKeys={null}
        routeDraftId={props.draftId}
        creatingDraftIds={creatingDraftIds}
        onNavigateToDraft={() => {}}
        onDraftContextMenu={() => {}}
      />
    </ul>
  );
}

it("replaces the submitted draft row and restores it after failed creation", async () => {
  useOptimisticThreadListStore.setState({ entriesByKey: {} });
  const original = useComposerDraftStore.getState();
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
  });
  const draftId = DraftId.make("creating-draft");
  const environmentId = EnvironmentId.make("creating");
  const projectId = ProjectId.make("project");
  const threadId = ThreadId.make("draft-thread");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId({ environmentId, projectId }, draftId, { threadId });
  useComposerDraftStore.getState().setPrompt(draftId, "Inspect worker");
  await using screen = await render(<DraftAndCreationRows draftId={draftId} />);
  try {
    await expect.element(screen.getByTestId("sidebar-draft-row")).toBeVisible();
    await act(() => {
      useOptimisticThreadListStore.getState().add({
        threadRef: scopeThreadRef(environmentId, threadId),
        projectId,
        title: "Inspect worker",
        createdAt: "2026-10-27T00:00:00Z",
        draftId,
      });
    });
    await expect.element(screen.getByTestId("sidebar-draft-row")).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Creating thread: Inspect worker" }))
      .toBeVisible();
    await act(() => {
      useOptimisticThreadListStore.getState().remove(scopeThreadRef(environmentId, threadId));
    });
    await expect.element(screen.getByTestId("sidebar-draft-row")).toBeVisible();
  } finally {
    useOptimisticThreadListStore.setState({ entriesByKey: {} });
    useComposerDraftStore.setState(original);
  }
});
