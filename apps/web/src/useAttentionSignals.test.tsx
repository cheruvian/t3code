import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  ready: true,
  hydrated: true,
  settings: {
    appIconUnreadBadgeEnabled: true,
    sessionFinishSoundEnabled: true,
    notificationMode: "off",
  },
  shells: [] as unknown[],
  visits: {} as Record<string, string>,
  sound: vi.fn(),
  badge: vi.fn(),
}));
vi.mock("./state/entities", () => ({
  useThreadShells: () => state.shells,
  useAllEnvironmentShellsBootstrapped: () => state.ready,
}));
vi.mock("./hooks/useSettings", () => ({
  useClientSettings: (select: (s: typeof state.settings) => unknown) => select(state.settings),
  useClientSettingsHydrated: () => state.hydrated,
  getClientSettings: () => state.settings,
}));
vi.mock("./uiStateStore", () => ({
  useUiStateStore: (select: (s: { threadLastVisitedAtById: typeof state.visits }) => unknown) =>
    select({ threadLastVisitedAtById: state.visits }),
}));
vi.mock("./threadNotifications", () => ({
  hasNotificationSound: (mode: string) => mode === "sound" || mode === "notifications-and-sound",
  playNotificationSound: state.sound,
  setNotificationBadge: state.badge,
  unlockNotificationAudio: vi.fn(),
}));
import { AttentionSignals } from "./useAttentionSignals";
let renderer: ReactTestRenderer | undefined;
const before = "2026-08-27T11:59:59Z";
const completed = "2026-08-27T12:00:00Z";
const after = "2026-08-27T12:00:01Z";
function shell(env: string, completedAt: string | null, visited: string = before) {
  return {
    environmentId: env,
    id: "same",
    latestRun: { completedAt },
    lastVisitedAt: visited,
    archivedAt: null,
    lineage: { relationshipToParent: null },
  };
}
async function render() {
  await act(async () => {
    if (renderer) renderer.update(<AttentionSignals />);
    else renderer = create(<AttentionSignals />);
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  state.ready = state.hydrated = true;
  state.settings = {
    appIconUnreadBadgeEnabled: true,
    sessionFinishSoundEnabled: true,
    notificationMode: "off",
  };
  state.shells = [];
  state.visits = {};
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { desktopBridge: {} }));
  vi.stubGlobal("document", new EventTarget());
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
it("baselines loaded completions without sound and keeps the badge until server visits acknowledge each environment", async () => {
  state.shells = [shell("one", completed), shell("two", completed)];
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(2, true);
  expect(state.sound).not.toHaveBeenCalled();
  window.dispatchEvent(new Event("focus"));
  expect(state.badge).toHaveBeenLastCalledWith(2, true);
  state.shells = [shell("one", completed, after), shell("two", completed)];
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(1, true);
  state.shells = [shell("one", completed, after), shell("two", completed, after)];
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(0, true);
});
it("plays once for a batch, avoids notification sound duplication, and applies preferences without replay", async () => {
  state.shells = [shell("one", null), shell("two", null)];
  await render();
  state.shells = [shell("one", completed), shell("two", completed)];
  await render();
  expect(state.sound).toHaveBeenCalledTimes(1);
  await render();
  expect(state.sound).toHaveBeenCalledTimes(1);
  state.settings.appIconUnreadBadgeEnabled = false;
  state.settings.sessionFinishSoundEnabled = false;
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(0, true);
  expect(state.sound.mock.calls[0]![1]()).toBe(false);
  state.settings.appIconUnreadBadgeEnabled = true;
  state.settings.sessionFinishSoundEnabled = true;
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(2, true);
  expect(state.sound).toHaveBeenCalledTimes(1);
  state.shells = [];
  await render();
  state.settings.notificationMode = "sound";
  state.shells = [shell("one", completed)];
  await render();
  expect(state.sound).toHaveBeenCalledTimes(1);
});
it("waits for settings and shells, baselines reconnects, and honors server visits over stale local values", async () => {
  state.ready = false;
  state.hydrated = false;
  state.shells = [shell("one", completed)];
  await render();
  expect(state.badge).not.toHaveBeenCalled();
  state.ready = true;
  await render();
  expect(state.badge).not.toHaveBeenCalled();
  state.hydrated = true;
  await render();
  expect(state.sound).not.toHaveBeenCalled();
  expect(state.badge).toHaveBeenLastCalledWith(1, true);
  state.ready = false;
  state.shells = [];
  await render();
  state.ready = true;
  state.shells = [shell("two", completed)];
  await render();
  expect(state.sound).not.toHaveBeenCalled();
  state.visits = {
    [scopedThreadKey(scopeThreadRef(EnvironmentId.make("two"), ThreadId.make("same")))]: after,
  };
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(1, true);
});
