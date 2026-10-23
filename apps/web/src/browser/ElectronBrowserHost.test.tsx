import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { AsyncResult, Atom } from "effect/reactivity";
import { type PreviewEvent, type PreviewListResult } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("./openFileInPreview", () => ({ openUrlInPreview: () => {} }));
vi.mock("./annotationTheme", () => ({ readPreviewAnnotationTheme: () => ({}) }));
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/state/entities", () => ({
  useServerConfigs: () =>
    new Map([["host", { environment: { capabilities: { nativeDesktopBrowser: true } } }]]),
}));
vi.mock("~/state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => () => {} }));
vi.mock("~/hooks/useSettings", () => ({ useClientSettingsHydrated: () => true }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("./browserDefaults", () => ({ useBrowserDefaults: () => ({ profileId: "default" }) }));
vi.mock("./HostedBrowserWebview", () => ({
  HostedBrowserWebview: ({ tabId, initialUrl }: { tabId: string; initialUrl: string | null }) => (
    <div role="document" data-tab={tabId}>
      {initialUrl}
    </div>
  ),
}));
vi.mock("~/state/primaryEnvironment", async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make("host") };
});
vi.mock("~/state/preview", async () => {
  return {
    previewEnvironment: {
      list: () => baseline,
      events: () => events,
      open: {},
    },
  };
});

import { ElectronBrowserHost } from "./ElectronBrowserHost";
import { appAtomRegistry, AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { resetPreviewStateForTests } from "~/previewStateStore";

const baseline = Atom.make(
  AsyncResult.success<PreviewListResult>({ sessions: [], serverEpoch: "server-a", revision: 0 }),
).pipe(Atom.keepAlive);
const events = Atom.make<AsyncResult.AsyncResult<PreviewEvent>>(AsyncResult.initial()).pipe(
  Atom.keepAlive,
);
let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(() => renderer?.unmount());
  resetPreviewStateForTests();
  vi.unstubAllGlobals();
});

it("creates a background agent tab without mounting that thread and follows its navigation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {});
  await act(() => {
    renderer = create(
      <AppAtomRegistryProvider>
        <ElectronBrowserHost />
      </AppAtomRegistryProvider>,
    );
  });
  expect(renderer?.root.findAllByProps({ role: "document" })).toHaveLength(0);
  const snapshot = {
    threadId: "background-thread",
    tabId: "agent-tab",
    runtime: "server" as const,
    navStatus: { _tag: "Success" as const, url: "https://example.com/login", title: "Login" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-10-23T20:00:00Z",
  };
  await act(() =>
    appAtomRegistry.set(
      events,
      AsyncResult.success({
        type: "opened",
        threadId: snapshot.threadId,
        tabId: snapshot.tabId,
        snapshot,
        serverEpoch: "server-a",
        revision: 1,
        createdAt: snapshot.updatedAt,
      }),
    ),
  );
  const surface = () => renderer!.root.findAllByProps({ role: "document" });
  expect(surface()).toHaveLength(1);
  expect(surface()[0]?.props["data-tab"]).toBe("agent-tab");
  expect(surface()[0]?.children).toEqual(["https://example.com/login"]);
  await act(() =>
    appAtomRegistry.set(
      events,
      AsyncResult.success({
        type: "navigated",
        threadId: snapshot.threadId,
        tabId: snapshot.tabId,
        snapshot: {
          ...snapshot,
          navStatus: { _tag: "Success", url: "https://example.com/photos", title: "Photos" },
        },
        serverEpoch: "server-a",
        revision: 2,
        createdAt: snapshot.updatedAt,
      }),
    ),
  );
  expect(surface()).toHaveLength(1);
  expect(surface()[0]?.children).toEqual(["https://example.com/photos"]);
});
