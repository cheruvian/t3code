import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createElement } from "react";
import { create, act } from "react-test-renderer";

const state = vi.hoisted(() => ({
  settings: null as UnifiedSettings | null,
  update: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("../../hooks/useTheme", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useTheme")>()),
  useTheme: () => ({
    theme: "system",
    followSystem: true,
    themeHalves: null,
    setTheme: vi.fn(),
    setFollowSystem: vi.fn(),
    setThemeHalf: vi.fn(),
    clearThemeHalves: vi.fn(),
  }),
  readThemePreference: () => "system",
  readThemeHalves: () => null,
  readAppearanceModePreference: () => "system",
}));

vi.mock("./useScopedSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useScopedSettings")>()),
  useScopedSettings: () => state.settings,
  useUpdateScopedSettings: () => state.update,
}));

vi.mock("../../localApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../localApi")>()),
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}));

import { useSettingsRestore } from "./useSettingsRestore";

function renderRestore() {
  let result: ReturnType<typeof useSettingsRestore> | undefined;
  function Hook() {
    result = useSettingsRestore();
    return null;
  }
  let root: ReturnType<typeof create>;
  act(() => {
    root = create(createElement(Hook));
  });
  act(() => root.unmount());
  return result!;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS };
  state.confirm.mockResolvedValue(true);
});

describe("restoring V2 settings", () => {
  it.each([
    ["persistComposerContextStrip", "Composer context"],
    ["autoResumeLimitedThreads", "Resume after usage limits"],
    ["snoozeLimitedThreads", "Snooze until limits reset"],
  ] as const)("restores %s when it is the only changed setting", async (key, label) => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, [key]: true };
    const restore = renderRestore();

    expect(restore.changedSettingLabels).toEqual([label]);
    await restore.restoreDefaults();

    expect(state.confirm.mock.calls[0]?.[0]).toContain(label);
    expect(state.update).toHaveBeenCalledOnce();
    expect(state.update.mock.calls[0]?.[0][key]).toBe(DEFAULT_UNIFIED_SETTINGS[key]);
  });

  it.each(["collapsed", "side-panel"] as const)(
    "restores the %s HTML preview default",
    async (htmlPreviewDefaultMode) => {
      state.settings = { ...DEFAULT_UNIFIED_SETTINGS, htmlPreviewDefaultMode };
      const restore = renderRestore();

      expect(restore.changedSettingLabels).toEqual(["HTML previews"]);
      await restore.restoreDefaults();

      expect(state.confirm.mock.calls[0]?.[0]).toContain("HTML previews");
      expect(state.update.mock.calls[0]?.[0].htmlPreviewDefaultMode).toBe("inline");
    },
  );

  it("does not reset settings after cancellation", async () => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, autoResumeLimitedThreads: true };
    state.confirm.mockResolvedValue(false);

    await renderRestore().restoreDefaults();

    expect(state.confirm).toHaveBeenCalledOnce();
    expect(state.update).not.toHaveBeenCalled();
  });
});
