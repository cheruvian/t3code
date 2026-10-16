import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

const mint = vi.hoisted(() => vi.fn());
const choose = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
vi.mock("./chat/PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../hooks/useFileMetadata", () => ({ useFileMetadata: () => undefined }));
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select: (value: typeof settings) => unknown) => select(settings),
  };
});
vi.mock("./ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("./ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("../state/projects", () => ({
  projectEnvironment: { resolveFilePaths: "resolveFilePaths", searchEntries: "searchEntries" },
}));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: (query: string) => (query === "resolveFilePaths" ? resolveFilePaths : mint),
}));
const resolveFilePaths = vi.fn().mockResolvedValue(AsyncResult.success([]));
vi.mock("../localApi", () => ({ readLocalApi: () => ({ contextMenu: { show: choose } }) }));
vi.mock("./ui/toast", () => ({
  toastManager: { add: toast },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  readPreparedConnection: () => ({ httpBaseUrl: "https://host.test" }),
  readEnvironmentScope: () => false,
  useEnvironmentScope: () => false,
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: "https://host.test" } }),
}));
vi.mock("../state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => false,
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectForChangeRequest: () => undefined,
  matchesLinkedPullRequestUrl: () => false,
  parseChangeRequestUrl: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "./ChatMarkdown";

it("opens host media through server authorization before the client grant loads", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mint.mockResolvedValue(
    AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 }),
  );
  const onImageExpand = vi.fn();
  const threadRef = {
    environmentId: EnvironmentId.make("media-environment"),
    threadId: ThreadId.make("media-thread"),
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        <ChatMarkdown
          cwd="/repo"
          threadRef={threadRef}
          text="[Open image](/tmp/image.png)"
          onImageExpand={onImageExpand}
        />,
      );
    });
    await act(async () => {
      const link = renderer!.root
        .findAllByType("a")
        .find((node) => node.props.href === "/tmp/image.png");
      expect(link).toBeDefined();
      link!.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });
    expect(onImageExpand).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [expect.objectContaining({ src: "https://host.test/api/assets/image.png" })],
      }),
    );
  } finally {
    await act(async () => renderer?.unmount());
    vi.unstubAllGlobals();
  }
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
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const download = { href: "", download: "", hidden: false, click: vi.fn(), remove: vi.fn() };
    const append = vi.fn();
    vi.stubGlobal("document", { createElement: () => download, body: { append } });
    mint
      .mockReset()
      .mockResolvedValue(
        AsyncResult.success({ relativeUrl: "/api/assets/download", expiresAt: 1 }),
      );
    choose.mockReset().mockResolvedValue("download");
    resolveFilePaths.mockResolvedValue(
      AsyncResult.success([{ path, absolutePath: path, relativePath: null }]),
    );
    const threadRef = {
      environmentId: EnvironmentId.make("remote"),
      threadId: ThreadId.make("thread"),
    };
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(<ChatMarkdown cwd="/repo" threadRef={threadRef} text={text} />);
      });
      await act(async () => {
        renderer!.root.findByType("a").props.onContextMenu({
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
          clientX: 10,
          clientY: 20,
        });
      });
      expect(choose.mock.lastCall![0]).toContainEqual({
        id: "download",
        label: "Download",
        icon: "download",
      });
      expect(mint).toHaveBeenCalledWith({
        environmentId: threadRef.environmentId,
        input: { resource: { _tag: "host-file-download", path } },
      });
      expect(download.href).toBe("https://host.test/api/assets/download");
      expect(download.download).toBe(name);
      expect(append).toHaveBeenCalledWith(download);
      expect(download.click).toHaveBeenCalledOnce();
      expect(download.remove).toHaveBeenCalledOnce();
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  },
);
