import { assetEnvironment } from "../state/assets";
import { projectEnvironment } from "../state/projects";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type AuthEnvironmentScope,
  type EditorId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { useRightPanelStore } from "../rightPanelStore";

const state = vi.hoisted(() => ({
  allowed: true,
  listeners: new Set<() => void>(),
  openEditor: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
  search: vi.fn(),
  resolveFiles: vi.fn(),
  metadata: vi.fn(),
  mint: vi.fn(),
  choose: vi.fn(),
  openFile: vi.fn(),
  openExternal: vi.fn(),
  copy: vi.fn(),
  pullRequests: [] as ThreadPullRequestLink[],
}));

vi.mock(import("../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: ((family: unknown) =>
    family === projectEnvironment.searchEntries
      ? state.search
      : family === projectEnvironment.resolveFilePaths
        ? state.resolveFiles
        : family === assetEnvironment.createUrl
          ? state.mint
          : state.metadata) as never,
}));
vi.mock(import("../state/use-atom-command"), async (original) => {
  const { threadEnvironment } = await import("../state/threads");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === threadEnvironment.linkPullRequest
        ? state.link
        : command === threadEnvironment.unlinkPullRequest
          ? state.unlink
          : state.openEditor) as never,
  };
});
vi.mock(import("../state/session"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const readEnvironmentScope = (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    id !== null &&
    (scope !== AuthOrchestrationOperateScope || id !== threadRef.environmentId || state.allowed);
  return {
    ...(await original()),
    readPreparedConnection: (() => ({ httpBaseUrl: "https://host.test" })) as never,
    readEnvironmentScope,
    useEnvironmentScope: (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => readEnvironmentScope(id, scope),
      ),
  };
});
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make(() => serverConfig);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => config) as never },
    environmentServerConfigsAtom: Atom.make(
      () => new Map([[threadRef.environmentId, serverConfig]]),
    ) as never,
  };
});
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readThreadShell: (() => ({ pullRequests: state.pullRequests })) as never,
  useProjects: (() => [
    { id: projectId, environmentId: threadRef.environmentId, workspaceRoot: "/repo" },
  ]) as never,
}));
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
vi.mock(import("../hooks/useLocalStorage"), async (original) => ({
  ...(await original()),
  useLocalStorage: (() => ["vscode", vi.fn()]) as never,
  getLocalStorageItem: (() => "vscode") as never,
}));
vi.mock(import("../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: () =>
    ({
      contextMenu: { show: state.choose },
      shell: { openExternal: state.openExternal },
    }) as never,
}));
vi.mock(import("@t3tools/client-runtime/change-request-links"), async (original) => ({
  ...(await original()),
  resolvePullRequestPreviewTarget: () => null,
  findProjectForChangeRequest: ((projects: readonly { id: ProjectId }[]) => projects[0]) as never,
}));

import ChatMarkdown from "./ChatMarkdown";

const threadRef = {
  environmentId: EnvironmentId.make("selected"),
  threadId: ThreadId.make("thread"),
};
const projectId = ProjectId.make("project");
const serverConfig = {
  availableEditors: ["vscode", "file-manager"] as readonly EditorId[],
  shellRevealInFileManager: true,
  shellRevealInFileManagerKind: "xdg-open",
  environment: {
    platform: { os: "linux" },
    capabilities: { threadPullRequests: true, threadLegacyPullRequest: true },
  },
};

function setup() {
  using stack = new DisposableStack();
  state.allowed = true;
  state.listeners.clear();
  state.pullRequests = [];
  state.openEditor.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.link.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.unlink.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.resolveFiles.mockReset().mockResolvedValue(AsyncResult.success([]));
  state.metadata
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ entries: [{ kind: "file" }] }));
  state.search.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  state.choose.mockReset().mockResolvedValue(null);
  state.openFile.mockReset();
  state.openExternal.mockReset().mockResolvedValue(undefined);
  state.copy.mockReset().mockResolvedValue(undefined);
  const { openFile } = useRightPanelStore.getState();
  useRightPanelStore.setState({ openFile: state.openFile });
  stack.defer(() => useRightPanelStore.setState({ openFile }));
  stack.use(vi.spyOn(navigator.clipboard, "writeText").mockImplementation(state.copy));
  stack.use(
    vi.spyOn(navigator.clipboard, "write").mockImplementation(async (items) => {
      const item = items[0]!;
      await state.copy(await (await item.getType("text/plain")).text());
    }),
  );
  return stack.move();
}

it("opens host media through server authorization before the client grant loads", async () => {
  using _setup = setup();
  state.allowed = false;
  state.mint.mockResolvedValue(
    AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 }),
  );
  const onImageExpand = vi.fn();
  const threadRef = {
    environmentId: EnvironmentId.make("media-environment"),
    threadId: ThreadId.make("media-thread"),
  };
  await using screen = await render(
    <ChatMarkdown
      cwd="/repo"
      threadRef={threadRef}
      text="[Open image](/tmp/image.png)"
      onImageExpand={onImageExpand}
    />,
    { router: false },
  );
  await act(async () => {
    screen.container.querySelector<HTMLAnchorElement>('a[href="/tmp/image.png"]')!.click();
  });
  expect(onImageExpand).toHaveBeenCalledWith(
    expect.objectContaining({
      images: [expect.objectContaining({ src: "https://host.test/api/assets/image.png" })],
    }),
  );
});

it.each([
  ["[Report](/tmp/report.xlsx)", "/tmp/report.xlsx", "report.xlsx"],
  ["[Report](outputs/report.xlsx)", "/repo/outputs/report.xlsx", "report.xlsx"],
  ["`/tmp/report.xlsx`", "/tmp/report.xlsx", "report.xlsx"],
  ["[Report](</tmp/report final.xlsx>)", "/tmp/report final.xlsx", "report final.xlsx"],
  ["[Source](/tmp/report.ts:12)", "/tmp/report.ts", "report.ts"],
])(
  "downloads a chat file reference through its remote environment: %s",
  async (text, path, name) => {
    using _setup = setup();
    state.mint
      .mockReset()
      .mockResolvedValue(
        AsyncResult.success({ relativeUrl: "/api/assets/download", expiresAt: 1 }),
      );
    state.choose.mockReset().mockResolvedValue("download");
    state.resolveFiles.mockResolvedValue(
      AsyncResult.success([{ path, absolutePath: path, relativePath: null }]),
    );
    const threadRef = {
      environmentId: EnvironmentId.make("remote"),
      threadId: ThreadId.make("thread"),
    };
    await using screen = await render(
      <ChatMarkdown cwd="/repo" threadRef={threadRef} text={text} />,
      { router: false },
    );
    let downloaded: HTMLAnchorElement | undefined;
    using _click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloaded = this;
    });
    using append = vi.spyOn(document.body, "append");
    await act(async () => {
      screen.container.querySelector("a")!.dispatchEvent(
        new PointerEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: 10,
          clientY: 20,
        }),
      );
    });
    expect(state.choose.mock.lastCall![0]).toContainEqual({
      id: "download",
      label: "Download",
      icon: "download",
    });
    expect(state.mint).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: { resource: { _tag: "host-file-download", path } },
    });
    expect(downloaded?.href).toBe("https://host.test/api/assets/download");
    expect(downloaded?.download).toBe(name);
    expect(append).toHaveBeenCalledWith(downloaded);
    expect(_click).toHaveBeenCalledOnce();
    expect(downloaded?.isConnected).toBe(false);
  },
);
