import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { type CommandId, ProjectId } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  ClaudeSettings,
  DEFAULT_SERVER_SETTINGS,
  globalIdleCompaction,
  idleCompactionPatch,
  requiredScopesForProjectMutation,
  resolveIdleCompaction,
  resolveProjectProviderInstanceEnabled,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
  withIdleCompaction,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

describe("ServerSettings response streaming", () => {
  it("defaults to paragraph buffering", () => {
    expect(decodeServerSettings({}).responseStreamingMode).toBe("paragraph");
  });

  it.each(["turn", "paragraph"])(
    "round-trips %s as an environment setting and project override",
    (responseStreamingMode) => {
      const input = {
        responseStreamingMode,
        projectSettingsOverrides: { project: { responseStreamingMode } },
      };
      expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
      expect(decodeServerSettingsPatch(input)).toEqual(input);
    },
  );

  it.each(["unsupported"])("rejects %s in settings snapshots and writes", (mode) => {
    for (const input of [
      { responseStreamingMode: mode },
      { projectSettingsOverrides: { project: { responseStreamingMode: mode } } },
    ]) {
      expect(() => decodeServerSettings(input)).toThrow();
      expect(() => decodeServerSettingsPatch(input)).toThrow();
    }
  });
});

describe("performance settings", () => {
  it("defaults existing settings and preserves partial tuning on the wire", () => {
    expect(decodeServerSettings({}).performance).toEqual({
      shellStateBatchMs: 50,
      shellTextBatchMs: 250,
      gitBranchChangesCacheMs: 10000,
      codexTextFlushMs: 100,
      eventLoopReportIntervalMs: 30000,
    });
    expect(
      encodeServerSettings(decodeServerSettings({ performance: { codexTextFlushMs: 200 } }))
        .performance,
    ).toEqual({
      shellStateBatchMs: 50,
      shellTextBatchMs: 250,
      gitBranchChangesCacheMs: 10000,
      codexTextFlushMs: 200,
      eventLoopReportIntervalMs: 30000,
    });
    expect(decodeServerSettingsPatch({ performance: { shellTextBatchMs: 500 } })).toEqual({
      performance: { shellTextBatchMs: 500 },
    });
  });

  it.each([
    { shellStateBatchMs: 0 },
    { shellStateBatchMs: 101 },
    { shellStateBatchMs: 10.5 },
    { shellTextBatchMs: 1001 },
    { gitBranchChangesCacheMs: -1 },
    { gitBranchChangesCacheMs: 60001 },
    { gitBranchChangesCacheMs: 1.5 },
    { codexTextFlushMs: 19 },
    { codexTextFlushMs: 501 },
    { eventLoopReportIntervalMs: 4999 },
    { eventLoopReportIntervalMs: 300001 },
  ])("rejects invalid timer values %j in reads and patches", (performance) => {
    expect(() => decodeServerSettings({ performance })).toThrow();
    expect(() => decodeServerSettingsPatch({ performance })).toThrow();
  });

  it("rejects a text window shorter than the state window", () => {
    expect(() =>
      decodeServerSettings({ performance: { shellStateBatchMs: 80, shellTextBatchMs: 60 } }),
    ).toThrow();
  });
});

describe("storage cleanup settings", () => {
  it("keeps cleanup disabled for existing installations", () => {
    expect(decodeServerSettings({}).worktreeCleanup).toBeNull();
    expect(decodeServerSettings({}).storageCleanup).toEqual({
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnPush: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      worktreeKeepWhen: "any-local-files",
      browserArtifactsAfterDays: null,
      logsAfterDays: null,
    });
  });

  it("accepts partial custom patches but requires complete stored project rules", () => {
    expect(
      decodeServerSettingsPatch({
        worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } },
      }),
    ).toEqual({ worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } });
    expect(() =>
      decodeServerSettings({
        projectSettingsOverrides: {
          project: { worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } },
        },
      }),
    ).toThrow();
    expect(
      decodeServerSettings({
        projectSettingsOverrides: {
          project: {
            worktreeCleanup: {
              mode: "custom",
              rules: {
                worktreeAfterDays: null,
                worktreeOnMerge: false,
                worktreeOnDelete: false,
                worktreeUnchanged: false,
              },
            },
          },
        },
      }).projectSettingsOverrides[ProjectId.make("project")]?.worktreeCleanup,
    ).toMatchObject({
      mode: "custom",
      rules: { worktreeSettledAfterDays: null, worktreeKeepWhen: "any-local-files" },
    });
  });

  it("decodes older custom rules with the default local-file policy", () => {
    const settings = decodeServerSettings({
      worktreeCleanup: {
        mode: "custom",
        rules: {
          worktreeAfterDays: 8,
          worktreeOnMerge: false,
          worktreeOnDelete: false,
          worktreeUnchanged: false,
        },
      },
    });
    expect(settings.worktreeCleanup).toMatchObject({
      rules: { worktreeKeepWhen: "any-local-files" },
    });
    expect(
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } }),
    ).toEqual({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } });
    expect(() =>
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "unknown" } }),
    ).toThrow();
  });
});

describe("ServerSettings usage price overrides", () => {
  const prices = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };

  it("rejects empty model IDs and incomplete input/output pricing", () => {
    for (const usagePriceOverrides of [
      { " ": prices },
      { "example-model": { inputCostPerMillionTokens: 2 } },
      { "example-model": { outputCostPerMillionTokens: 8 } },
    ]) {
      expect(() => decodeServerSettingsPatch({ usagePriceOverrides })).toThrow();
    }
  });
});

describe("custom model settings", () => {
  const capabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
      },
    ],
  };

  it("accepts legacy bare slugs alongside full entries", () => {
    const decoded = decodeClaudeSettings({
      customModels: ["bare-slug", { slug: "named", name: "Named", capabilities }],
    });
    expect(decoded.customModels).toEqual([
      "bare-slug",
      { slug: "named", name: "Named", capabilities },
    ]);
  });
});

describe("resolveIdleCompaction", () => {
  it("lets a Claude instance override the global default", () => {
    const settings = decodeServerSettings({
      idleCompaction: "off",
      providerInstances: {
        claude_work: { driver: "claudeAgent", config: { idleCompaction: "onReturn" } },
        claude_personal: { driver: "claudeAgent" },
      },
    });
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claude_work"))).toBe(
      "onReturn",
    );
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claude_personal"))).toBe("off");
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claudeAgent"))).toBe("off");
  });

  it("reads the mode from the legacy switch, in either form servers saved it", () => {
    expect(globalIdleCompaction(decodeServerSettings({ compactIdleThreads: true }))).toBe(
      "beforeCacheExpires",
    );
    expect(globalIdleCompaction(decodeServerSettings({ compactIdleThreads: "off" }))).toBe("off");
    expect(globalIdleCompaction(decodeServerSettings({}))).toBe("onReturn");
  });

  it("keeps the legacy switch a boolean, as shipped clients decode it", () => {
    const encode = Schema.encodeSync(Schema.toCodecJson(ServerSettings));
    for (const mode of ["onReturn", "beforeCacheExpires", "off"] as const) {
      const encoded = encode(withIdleCompaction(DEFAULT_SERVER_SETTINGS, mode)) as {
        readonly compactIdleThreads: unknown;
        readonly idleCompaction: unknown;
      };
      expect(encoded.compactIdleThreads).toBe(mode === "beforeCacheExpires");
      expect(encoded.idleCompaction).toBe(mode);
    }
  });

  it("patches the field the server reads", () => {
    expect(
      idleCompactionPatch({ compactIdleThreads: false, idleCompaction: "onReturn" }, "off"),
    ).toEqual({
      idleCompaction: "off",
    });
    expect(idleCompactionPatch({ compactIdleThreads: "onReturn" }, "off")).toEqual({
      compactIdleThreads: "off",
    });
    expect(idleCompactionPatch({ compactIdleThreads: false }, "beforeCacheExpires")).toEqual({
      compactIdleThreads: true,
    });
  });
});

describe("ClientSettings notifications", () => {
  it("requires opt-in when existing settings omit notification preferences", () => {
    expect(decodeClientSettings({}).notificationMode).toBe("off");
    expect(decodeClientSettings({}).inAppNotificationsEnabled).toBe(false);
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("inAppNotificationsEnabled");
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("notificationMode");
  });

  it.each([true, false])(
    "round-trips in-app notifications set to %s",
    (inAppNotificationsEnabled) => {
      const settings = decodeClientSettings({ inAppNotificationsEnabled });
      expect(encodeClientSettings(settings).inAppNotificationsEnabled).toBe(
        inAppNotificationsEnabled,
      );
      expect(
        decodeClientSettingsPatch({ inAppNotificationsEnabled }).inAppNotificationsEnabled,
      ).toBe(inAppNotificationsEnabled);
    },
  );

  it.each(["true", 1, null])(
    "rejects an invalid in-app notification preference %s",
    (inAppNotificationsEnabled) => {
      expect(() => decodeClientSettings({ inAppNotificationsEnabled })).toThrow();
      expect(() => decodeClientSettingsPatch({ inAppNotificationsEnabled })).toThrow();
    },
  );

  it.each(["off", "notifications", "sound", "notifications-and-sound"])(
    "round-trips the %s mode",
    (notificationMode) => {
      const settings = decodeClientSettings({ notificationMode });
      expect(encodeClientSettings(settings).notificationMode).toBe(notificationMode);
      expect(decodeClientSettingsPatch({ notificationMode }).notificationMode).toBe(
        notificationMode,
      );
    },
  );

  it.each(["always", true, null])(
    "rejects unsupported notification mode %s",
    (notificationMode) => {
      expect(() => decodeClientSettings({ notificationMode })).toThrow();
      expect(() => decodeClientSettingsPatch({ notificationMode })).toThrow();
    },
  );
});

describe("ClientSettings default diff file state", () => {
  it("keeps files collapsed when existing settings omit the preference", () => {
    expect(decodeClientSettings({}).diffFilesCollapsed).toBe(true);
  });

  it.each([true, false])("preserves a saved collapsed preference of %s", (diffFilesCollapsed) => {
    const settings = decodeClientSettings({ diffFilesCollapsed });
    expect(encodeClientSettings(settings).diffFilesCollapsed).toBe(diffFilesCollapsed);
    expect(decodeClientSettingsPatch({ diffFilesCollapsed }).diffFilesCollapsed).toBe(
      diffFilesCollapsed,
    );
  });
});

describe("ClientSettings diff colors", () => {
  it("keeps red and green for existing settings without a saved palette", () => {
    expect(decodeClientSettings({}).diffColorScheme).toBe("red-green");
  });

  it.each(["red-green", "blue-orange"])("round-trips the %s palette", (diffColorScheme) => {
    const settings = decodeClientSettings({ diffColorScheme });
    expect(encodeClientSettings(settings).diffColorScheme).toBe(diffColorScheme);
    expect(decodeClientSettingsPatch({ diffColorScheme }).diffColorScheme).toBe(diffColorScheme);
  });

  it("rejects unsupported palettes", () => {
    expect(() => decodeClientSettings({ diffColorScheme: "purple-yellow" })).toThrow();
    expect(() => decodeClientSettingsPatch({ diffColorScheme: "purple-yellow" })).toThrow();
  });
});

describe("ClientSettings chat width", () => {
  it("keeps the comfortable width for existing settings without a saved width", () => {
    expect(decodeClientSettings({}).chatWidth).toBe("comfortable");
  });

  it.each(["comfortable", "wide", "full"])("round-trips the %s width", (chatWidth) => {
    const settings = decodeClientSettings({ chatWidth });
    expect(encodeClientSettings(settings).chatWidth).toBe(chatWidth);
    expect(decodeClientSettingsPatch({ chatWidth }).chatWidth).toBe(chatWidth);
  });

  it("rejects unsupported widths", () => {
    expect(() => decodeClientSettings({ chatWidth: "huge" })).toThrow();
    expect(() => decodeClientSettingsPatch({ chatWidth: "huge" })).toThrow();
  });
});

describe("ClientSettings HTML preview defaults", () => {
  it("keeps previews open in chat when saved settings omit the preference", () => {
    expect(decodeClientSettings({}).htmlPreviewDefaultMode).toBe("inline");
  });

  it.each(["inline", "collapsed", "side-panel"])(
    "persists the %s mode",
    (htmlPreviewDefaultMode) => {
      const saved = encodeClientSettings(decodeClientSettings({ htmlPreviewDefaultMode }));
      expect(decodeClientSettings(saved).htmlPreviewDefaultMode).toBe(htmlPreviewDefaultMode);
      expect(decodeClientSettingsPatch({ htmlPreviewDefaultMode }).htmlPreviewDefaultMode).toBe(
        htmlPreviewDefaultMode,
      );
    },
  );

  it("rejects unsupported modes in saved settings and patches", () => {
    expect(() => decodeClientSettings({ htmlPreviewDefaultMode: "floating" })).toThrow();
    expect(() => decodeClientSettingsPatch({ htmlPreviewDefaultMode: "floating" })).toThrow();
  });
});

describe("ClientSettings load balancing", () => {
  it("requires opt-in when settings are new or omit load balancing", () => {
    expect(decodeClientSettings({}).loadBalancingEnabled).toBe(false);
    expect(decodeClientSettings({ loadBalancingWeights: {} }).loadBalancingEnabled).toBe(false);
  });

  it.each([true, false])("preserves a saved choice of %s", (loadBalancingEnabled) => {
    const settings = decodeClientSettings({ loadBalancingEnabled });
    expect(encodeClientSettings(settings).loadBalancingEnabled).toBe(loadBalancingEnabled);
    expect(decodeClientSettingsPatch({ loadBalancingEnabled }).loadBalancingEnabled).toBe(
      loadBalancingEnabled,
    );
  });
});

describe("ClientSettings composer context strip", () => {
  it("defaults to draft-only and accepts a persistent strip preference", () => {
    expect(decodeClientSettings({}).persistComposerContextStrip).toBe(false);
    expect(
      decodeClientSettingsPatch({ persistComposerContextStrip: true }).persistComposerContextStrip,
    ).toBe(true);
  });
});

describe("ClientSettings word wrap", () => {
  it("defaults word wrap on", () => {
    expect(decodeClientSettings({}).wordWrap).toBe(true);
  });

  it("ignores obsolete wrapping preferences", () => {
    const decoded = decodeClientSettings({
      chatWordWrap: false,
      diffWordWrap: false,
    });

    expect(decoded.wordWrap).toBe(true);
    expect(decoded).not.toHaveProperty("chatWordWrap");
    expect(decoded).not.toHaveProperty("diffWordWrap");
  });
});

describe("ClientSettings window capture", () => {
  it("defaults capture off while keeping its feedback enabled", () => {
    const settings = decodeClientSettings({});

    expect(settings.snapShotEnabled).toBe(false);
    expect(settings.snapShotIncludeAccessibility).toBe(true);
    expect(settings.snapShotShortcut).toEqual({ kind: "both-shift-keys" });
    expect(settings.snapShotPlaySound).toBe(true);
    expect(settings.snapShotSound).toBe("soft-pop");
    expect(settings.snapShotFlash).toBe(true);
    expect(settings.snapShotAnimations).toBe(true);
  });

  it("accepts capture preference updates", () => {
    expect(
      decodeClientSettingsPatch({
        snapShotEnabled: true,
        snapShotIncludeAccessibility: false,
        snapShotShortcut: {
          key: "w",
          metaKey: false,
          ctrlKey: false,
          shiftKey: true,
          altKey: true,
          modKey: false,
        },
        snapShotPlaySound: false,
        snapShotSound: "camera-shutter",
        snapShotFlash: false,
        snapShotAnimations: false,
      }),
    ).toEqual({
      snapShotEnabled: true,
      snapShotIncludeAccessibility: false,
      snapShotShortcut: {
        key: "w",
        metaKey: false,
        ctrlKey: false,
        shiftKey: true,
        altKey: true,
        modKey: false,
      },
      snapShotPlaySound: false,
      snapShotSound: "camera-shutter",
      snapShotFlash: false,
      snapShotAnimations: false,
    });
  });

  it("rejects unknown capture sounds", () => {
    expect(() => decodeClientSettingsPatch({ snapShotSound: "doorbell" })).toThrow();
  });

  it("accepts modifier pair shortcuts", () => {
    expect(
      decodeClientSettingsPatch({
        snapShotShortcut: { kind: "modifier-pair", modifier: "meta" },
      }),
    ).toEqual({
      snapShotShortcut: { kind: "modifier-pair", modifier: "meta" },
    });
    expect(() =>
      decodeClientSettingsPatch({
        snapShotShortcut: { kind: "modifier-pair", modifier: "hyper" },
      }),
    ).toThrow();
  });

  it("rejects a capture shortcut with no modifier", () => {
    expect(() =>
      decodeClientSettingsPatch({
        snapShotShortcut: {
          key: "w",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: false,
        },
      }),
    ).toThrow();
  });
});

describe("ClientSettings proactive panels", () => {
  it("is opt-in and accepts client-local updates", () => {
    expect(decodeClientSettings({}).proactivePanelsEnabled).toBe(false);
    expect(decodeClientSettingsPatch({ proactivePanelsEnabled: true }).proactivePanelsEnabled).toBe(
      true,
    );
  });
});

describe("ClientSettings quit confirmation", () => {
  it.each([
    [true, "hold"],
    [false, "direct"],
  ] as const)("migrates the legacy %s value to %s", (legacyValue, mode) => {
    const settings = decodeClientSettings({ confirmQuit: legacyValue });

    expect(settings.confirmQuit).toBe(mode);
    expect(encodeClientSettings(settings).confirmQuit).toBe(mode);
  });

  it("rejects legacy booleans at the patch boundary", () => {
    expect(() => decodeClientSettingsPatch({ confirmQuit: true })).toThrow();
  });
});

describe("ClientSettings browser recording frame rate", () => {
  it("defaults to 30 fps", () => {
    expect(decodeClientSettings({}).browserRecordingFrameRate).toBe(30);
  });

  it.each([30, 60])("accepts a supported frame rate: %s", (frameRate) => {
    expect(
      decodeClientSettings({ browserRecordingFrameRate: frameRate }).browserRecordingFrameRate,
    ).toBe(frameRate);
    expect(
      decodeClientSettingsPatch({ browserRecordingFrameRate: frameRate }).browserRecordingFrameRate,
    ).toBe(frameRate);
  });

  it.each([24, 59, 120])("rejects an unsupported frame rate: %s", (frameRate) => {
    expect(() => decodeClientSettings({ browserRecordingFrameRate: frameRate })).toThrow();
    expect(() => decodeClientSettingsPatch({ browserRecordingFrameRate: frameRate })).toThrow();
  });
});

describe("ClientSettings recording input overlays", () => {
  it("defaults both overlays off and accepts independent opt-ins", () => {
    const settings = decodeClientSettings({});
    expect(settings.browserRecordingShowKeyPresses).toBe(false);
    expect(settings.browserRecordingShowMousePresses).toBe(false);
    expect(
      decodeClientSettingsPatch({
        browserRecordingShowKeyPresses: true,
        browserRecordingShowMousePresses: false,
      }),
    ).toMatchObject({
      browserRecordingShowKeyPresses: true,
      browserRecordingShowMousePresses: false,
    });
  });
});

describe("ClientSettings glass opacity", () => {
  it("defaults to a readable translucent surface", () => {
    expect(decodeClientSettings({}).glassOpacity).toBe(80);
  });

  it.each([39, 101, 72.5])("rejects an invalid glass opacity: %s", (value) => {
    expect(() => decodeClientSettings({ glassOpacity: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ glassOpacity: value })).toThrow();
  });

  it.each([40, 75, 100])("accepts a glass opacity within the supported range: %s", (value) => {
    expect(decodeClientSettings({ glassOpacity: value }).glassOpacity).toBe(value);
    expect(decodeClientSettingsPatch({ glassOpacity: value }).glassOpacity).toBe(value);
  });
});

describe("ClientSettings appearance contrast", () => {
  it("defaults to the theme's original contrast", () => {
    expect(decodeClientSettings({}).appearanceContrast).toBe(100);
  });

  it.each([49, 201, 92.5])("rejects an invalid appearance contrast: %s", (value) => {
    expect(() => decodeClientSettings({ appearanceContrast: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ appearanceContrast: value })).toThrow();
  });

  it.each([50, 100, 150, 200])("accepts an appearance contrast in range: %s", (value) => {
    expect(decodeClientSettings({ appearanceContrast: value }).appearanceContrast).toBe(value);
    expect(decodeClientSettingsPatch({ appearanceContrast: value }).appearanceContrast).toBe(value);
  });
});

describe("ClientSettings panel animations", () => {
  it("defaults to instant changes", () => {
    expect(decodeClientSettings({}).panelAnimationDurationMs).toBe(0);
  });

  it.each([0, 400])("accepts a panel animation duration: %s", (value) => {
    expect(decodeClientSettingsPatch({ panelAnimationDurationMs: value })).toEqual({
      panelAnimationDurationMs: value,
    });
  });

  it.each([-1, 401, 150.5])("rejects an invalid panel animation duration: %s", (value) => {
    expect(() => decodeClientSettingsPatch({ panelAnimationDurationMs: value })).toThrow();
  });
});

describe("ClientSettings environment identification", () => {
  it("defaults to artwork and accepts each presentation mode", () => {
    expect(decodeClientSettings({}).environmentIdentificationMode).toBe("artwork");

    for (const mode of ["artwork", "pill", "none"] as const) {
      expect(
        decodeClientSettingsPatch({ environmentIdentificationMode: mode })
          .environmentIdentificationMode,
      ).toBe(mode);
    }
  });

  it("rejects unsupported presentation modes", () => {
    expect(() => decodeClientSettings({ environmentIdentificationMode: "badge" })).toThrow();
    expect(() => decodeClientSettingsPatch({ environmentIdentificationMode: "badge" })).toThrow();
  });
});

describe("ClientSettings sidebar", () => {
  it("defaults to the current compact sidebar", () => {
    const settings = decodeClientSettings({});
    expect(settings.sidebarCompactMode).toBe(true);
    expect(settings.sidebarAllowUnpinnedReorder).toBe(false);
  });

  it("drops the retired sidebar v2 beta keys, resetting everyone to the default", () => {
    const decoded = decodeClientSettings({
      sidebarV2Enabled: false,
      sidebarV2ConfiguredByUser: true,
    });
    expect(decoded).not.toHaveProperty("sidebarV2Enabled");
    expect(decoded).not.toHaveProperty("sidebarV2ConfiguredByUser");
  });

  it("drops the retired compact sidebar keys for users who opted in", () => {
    const stored = { compactSidebarEnabled: true, sidebarCompactThreadRows: true };
    const decoded = decodeClientSettings(stored);
    expect(decoded).not.toHaveProperty("compactSidebarEnabled");
    expect(decoded).not.toHaveProperty("sidebarCompactThreadRows");
    expect(decodeClientSettingsPatch(stored)).toEqual({});
  });

  it("drops an old legacy sidebar preference", () => {
    expect(decodeClientSettings({ legacySidebarEnabled: true })).not.toHaveProperty(
      "legacySidebarEnabled",
    );
    expect(decodeClientSettingsPatch({ legacySidebarEnabled: true })).toEqual({});
  });

  it("supports opting out of compact inbox rows", () => {
    expect(
      decodeClientSettings({ sidebarAllowUnpinnedReorder: true }).sidebarAllowUnpinnedReorder,
    ).toBe(true);
    expect(
      decodeClientSettingsPatch({ sidebarAllowUnpinnedReorder: false }).sidebarAllowUnpinnedReorder,
    ).toBe(false);
    expect(decodeClientSettings({ sidebarCompactMode: false }).sidebarCompactMode).toBe(false);
    expect(decodeClientSettingsPatch({ sidebarCompactMode: false }).sidebarCompactMode).toBe(false);
  });

  it("keeps unpin confirmation opt-in and patchable", () => {
    expect(decodeClientSettings({}).confirmThreadUnpin).toBe(false);
    expect(decodeClientSettingsPatch({ confirmThreadUnpin: true }).confirmThreadUnpin).toBe(true);
    expect(() => decodeClientSettingsPatch({ confirmThreadUnpin: "yes" })).toThrow();
  });
});

describe("ClientSettings context window meter", () => {
  it("defaults off and preserves an explicit legacy opt-in", () => {
    expect(decodeClientSettings({}).contextWindowMeterEnabled).toBe(false);
    expect(
      decodeClientSettings({ contextWindowMeterEnabled: true }).contextWindowMeterEnabled,
    ).toBe(true);
    expect(
      decodeClientSettingsPatch({ contextWindowMeterEnabled: true }).contextWindowMeterEnabled,
    ).toBe(true);
  });
});

describe("ClientSettings send shortcut", () => {
  it("defaults to Enter and validates the supported choices", () => {
    expect(decodeClientSettings({}).sendShortcut).toBe("enter");
    for (const sendShortcut of ["enter", "mod-enter-multiline", "mod-enter"]) {
      expect(decodeClientSettings({ sendShortcut }).sendShortcut).toBe(sendShortcut);
      expect(decodeClientSettingsPatch({ sendShortcut }).sendShortcut).toBe(sendShortcut);
    }
    expect(() => decodeClientSettingsPatch({ sendShortcut: "invalid" })).toThrow();
  });
});

describe("ClientSettings follow-up behavior", () => {
  it("defaults to steer and accepts either behavior", () => {
    expect(decodeClientSettings({}).followUpBehavior).toBe("steer");
    for (const followUpBehavior of ["queue", "steer"]) {
      expect(decodeClientSettings({ followUpBehavior }).followUpBehavior).toBe(followUpBehavior);
      expect(decodeClientSettingsPatch({ followUpBehavior }).followUpBehavior).toBe(
        followUpBehavior,
      );
    }
    expect(() => decodeClientSettingsPatch({ followUpBehavior: "invalid" })).toThrow();
  });
});

describe("ClientSettings composer collapse", () => {
  it("collapses on scroll by default and accepts opting out", () => {
    expect(decodeClientSettings({}).composerCollapseOnScroll).toBe(true);
    expect(
      decodeClientSettingsPatch({ composerCollapseOnScroll: false }).composerCollapseOnScroll,
    ).toBe(false);
  });

  it("drops the retired blur trigger key", () => {
    const decoded = decodeClientSettings({ composerCollapseOnBlur: false });
    expect(decoded.composerCollapseOnScroll).toBe(true);
    expect(decoded).not.toHaveProperty("composerCollapseOnBlur");
  });
});

describe("ServerSettings thread settlement", () => {
  it("defaults merge settlement on and inactivity settlement to three days", () => {
    const settings = decodeServerSettings({});
    expect(settings.sidebarAutoSettleAfterDays).toBe(3);
    expect(settings.sidebarAutoSettleOnMerge).toBe(true);
  });

  it("allows both automatic rules to be disabled", () => {
    expect(
      decodeServerSettings({
        sidebarAutoSettleAfterDays: null,
        sidebarAutoSettleOnMerge: false,
      }),
    ).toMatchObject({ sidebarAutoSettleAfterDays: null, sidebarAutoSettleOnMerge: false });
    expect(
      decodeServerSettingsPatch({
        sidebarAutoSettleAfterDays: null,
        sidebarAutoSettleOnMerge: false,
      }),
    ).toMatchObject({ sidebarAutoSettleAfterDays: null, sidebarAutoSettleOnMerge: false });
  });

  it.each([-1, 0, 91])("rejects an auto-settle threshold outside 1..90: %s", (value) => {
    expect(() => decodeServerSettings({ sidebarAutoSettleAfterDays: value })).toThrow();
    expect(() => decodeServerSettingsPatch({ sidebarAutoSettleAfterDays: value })).toThrow();
  });
});

describe("ClientSettings pull request merge methods", () => {
  it("defaults to no project overrides and accepts supported methods", () => {
    expect(decodeClientSettings({}).pullRequestMergeMethodOverrides).toEqual({});
    expect(
      decodeClientSettingsPatch({
        pullRequestMergeMethodOverrides: { project: "squash" },
      }).pullRequestMergeMethodOverrides,
    ).toEqual({ project: "squash" });
  });

  it("rejects unsupported project merge methods", () => {
    expect(() =>
      decodeClientSettingsPatch({
        pullRequestMergeMethodOverrides: { project: "fast-forward" },
      }),
    ).toThrow();
  });
});

describe("ServerSettings.providerInstances (slice-2 invariant)", () => {
  it("defaults to an empty record so legacy configs without the key still decode", () => {
    expect(DEFAULT_SERVER_SETTINGS.providerInstances).toEqual({});
  });

  it("decodes a fully empty config (legacy on-disk shape) without complaint", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.providerInstances).toEqual({});
  });

  it("decodes a multi-instance map mixing first-party and fork drivers", () => {
    const decoded = decodeServerSettings({
      providerInstances: {
        codex_personal: {
          driver: "codex",
          displayName: "Codex (personal)",
          config: { homePath: "~/.codex_personal" },
        },
        codex_work: {
          driver: "codex",
          config: { homePath: "~/.codex_work" },
        },
        ollama_local: {
          driver: "ollama",
          displayName: "Ollama (local)",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const personalId = ProviderInstanceId.make("codex_personal");
    const workId = ProviderInstanceId.make("codex_work");
    const ollamaId = ProviderInstanceId.make("ollama_local");

    expect(decoded.providerInstances[personalId]?.driver).toBe("codex");
    expect(decoded.providerInstances[workId]?.config).toEqual({ homePath: "~/.codex_work" });
    expect(decoded.providerInstances[ollamaId]?.driver).toBe("ollama");
    expect(decoded.providerInstances[ollamaId]?.config).toEqual({
      endpoint: "http://localhost:11434",
    });
  });

  it("rejects instance keys that violate the slug pattern", () => {
    expect(() =>
      decodeServerSettings({
        providerInstances: { "1bad": { driver: "codex" } },
      }),
    ).toThrow();
  });
});

describe("provider enabled defaults", () => {
  it("resolves instance enabled state with explicit false winning", () => {
    const grok = ProviderDriverKind.make("grok");
    const codex = ProviderDriverKind.make("codex");
    expect(resolveProviderInstanceEnabled({ driver: grok, config: {} })).toBe(false);
    expect(resolveProviderInstanceEnabled({ driver: codex, config: {} })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: ProviderDriverKind.make("ollama"), config: {} }),
    ).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: {} })).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: {} })).toBe(
      false,
    );
    expect(resolveProviderInstanceEnabled({ driver: grok, config: { enabled: true } })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: { enabled: false } }),
    ).toBe(false);
    expect(
      resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: { enabled: true } }),
    ).toBe(false);
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults global actions for legacy settings and decodes replacements", () => {
    expect(decodeServerSettings({}).globalScripts).toEqual([]);
    expect(
      decodeServerSettingsPatch({
        globalScripts: [
          {
            id: "lint",
            name: "Lint",
            command: "vp lint",
            icon: "lint",
            runOnWorktreeCreate: false,
          },
        ],
      }).globalScripts,
    ).toHaveLength(1);
  });

  it("defaults the thread env mode to inherit and keeps stored values", () => {
    expect(decodeServerSettings({}).defaultThreadEnvMode).toBeNull();
    expect(decodeServerSettings({ defaultThreadEnvMode: "worktree" }).defaultThreadEnvMode).toBe(
      "worktree",
    );
    expect(
      decodeServerSettings({ defaultThreadEnvMode: "remote" }).defaultThreadEnvMode,
    ).toBeNull();
    expect(
      decodeServerSettingsPatch({ defaultThreadEnvMode: null }).defaultThreadEnvMode,
    ).toBeNull();
  });

  it("keeps an inherited thread env mode off the wire for older clients", () => {
    const encode = Schema.encodeSync(ServerSettings);
    expect("defaultThreadEnvMode" in encode(decodeServerSettings({}))).toBe(false);
    expect(
      encode(decodeServerSettings({ defaultThreadEnvMode: "worktree" })).defaultThreadEnvMode,
    ).toBe("worktree");
  });
});

describe("ServerSettings.sourceControlWritingStyle", () => {
  it.each([
    { legacy: "", mode: "repo_conventions", customInstructions: "" },
    { legacy: " \t\n ", mode: "repo_conventions", customInstructions: "" },
    {
      legacy: "  Prefer concise wording.\nKeep issue references.  ",
      mode: "custom",
      customInstructions: "Prefer concise wording.\nKeep issue references.",
    },
  ])("normalizes legacy writing style $legacy in snapshots only", ({ legacy, ...expected }) => {
    const style = { ...expected, followChangeRequestTemplates: true };
    for (const [input, normalized] of [
      [{ sourceControlWritingStyle: legacy }, { sourceControlWritingStyle: style }],
      [
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: legacy } } },
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: style } } },
      ],
    ] as const) {
      const settings = decodeServerSettings(input);
      expect(settings).toMatchObject(normalized);
      expect(encodeServerSettings(settings)).toMatchObject(normalized);
      expect(() => decodeServerSettingsPatch(input)).toThrow();
    }
  });
});

describe("ServerSettings environment icon", () => {
  it("defaults project artwork off and preserves a selected project", () => {
    expect(decodeServerSettings({}).environmentIconProjectId).toBeNull();
    const settings = decodeServerSettings({ environmentIconProjectId: "heihei-project" });
    expect(encodeServerSettings(settings).environmentIconProjectId).toBe("heihei-project");
    expect(
      decodeServerSettings({ environmentIconProjectId: null }).environmentIconProjectId,
    ).toBeNull();
  });

  it("defaults to null", () => {
    expect(decodeServerSettings({}).environmentIcon).toBeNull();
  });

  it("keeps a kind this build knows", () => {
    expect(decodeServerSettings({ environmentIcon: "mac-mini" }).environmentIcon).toBe("mac-mini");
    expect(decodeServerSettings({ environmentIcon: "linux" }).environmentIcon).toBe("linux");
  });

  it("decodes a kind from a newer server as null instead of failing the snapshot", () => {
    expect(decodeServerSettings({ environmentIcon: "toaster" }).environmentIcon).toBeNull();
  });
});

const decodeDeviceHostSettings = Schema.decodeSync(ServerSettings);

// `deviceHosts` as it was decoded before EAS hosts existed: an SSH host needs a target.
const decodeOlderDeviceHostSettings = Schema.decodeUnknownSync(
  Schema.Struct({
    deviceHosts: Schema.Array(Schema.Struct({ id: Schema.String, target: Schema.String })),
  }),
);

it("keeps EAS hosts out of the SSH host list servers and clients before EAS hosts decode", () => {
  const settings = decodeDeviceHostSettings({
    deviceHosts: [{ id: "mini", label: "Mac mini", target: "user@mini" }],
    easDeviceHosts: [{ kind: "eas", id: "eas", label: "EAS Simulator" }],
  });
  const wire = encodeServerSettings(settings);
  expect(decodeOlderDeviceHostSettings(wire).deviceHosts).toEqual([
    { id: "mini", target: "user@mini" },
  ]);
  expect(settings.easDeviceHosts.map((host) => host.id)).toEqual(["eas"]);
});

it("validates remote device hosts and rejects ambiguous host ids", () => {
  const host = { id: "mini", label: "Mac mini", target: "user@mini", port: 2222 };
  // Hosts saved before EAS hosts existed have no `kind`; they are SSH hosts.
  expect(decodeDeviceHostSettings({ deviceHosts: [host] }).deviceHosts).toEqual([
    { kind: "ssh", ...host },
  ]);
  expect(() => decodeDeviceHostSettings({ deviceHosts: [host, host] })).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, id: "local" }] })).toThrow();
  expect(() =>
    decodeDeviceHostSettings({ deviceHosts: [{ ...host, target: "-oProxyCommand=bad" }] }),
  ).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, port: 0 }] })).toThrow();
});

describe("branch naming settings", () => {
  it("defaults existing settings to the t3 static prefix", () => {
    expect(decodeServerSettings({})).toMatchObject({
      branchNamingMode: "static",
      branchNamePrefix: "t3",
      branchNameInstructions: "",
    });
  });
  it.each(["static", "semantic", "custom"])(
    "round-trips %s and project overrides",
    (branchNamingMode) => {
      const naming = {
        branchNamingMode,
        branchNamePrefix: "team/",
        branchNameInstructions: "Include the issue ID.",
      };
      const input = { ...naming, projectSettingsOverrides: { project: naming } };
      expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
      expect(decodeServerSettingsPatch(input)).toEqual(input);
    },
  );
});

describe("ServerSettings.removeAgentCreditsOnMerge", () => {
  it("keeps agent credits by default and accepts opt-in patches", () => {
    expect(decodeServerSettings({}).removeAgentCreditsOnMerge).toBe(false);
    expect(
      decodeServerSettingsPatch({ removeAgentCreditsOnMerge: true }).removeAgentCreditsOnMerge,
    ).toBe(true);
    expect(
      decodeServerSettings({
        projectSettingsOverrides: { project: { removeAgentCreditsOnMerge: true } },
      }).projectSettingsOverrides["project" as ProjectId]?.removeAgentCreditsOnMerge,
    ).toBe(true);
  });
});

describe("saved prompts", () => {
  it("keeps existing environments empty and defaults prompts to insert", () => {
    expect(decodeServerSettings({}).savedPrompts).toEqual([]);
    const savedPrompts = [{ id: "commit", name: "Commit", text: "Commit all local changes." }];
    const expected = [{ ...savedPrompts[0], behavior: "insert" }];
    expect(decodeServerSettings({ savedPrompts }).savedPrompts).toEqual(expected);
    expect(decodeServerSettingsPatch({ savedPrompts })).toEqual({ savedPrompts: expected });
  });

  it("round-trips immediate send and rejects empty text or unknown behavior", () => {
    const savedPrompts = [
      { id: "review", name: "Review", text: "Review concerns.", behavior: "send" },
    ];
    expect(encodeServerSettings(decodeServerSettings({ savedPrompts }))).toMatchObject({
      savedPrompts,
    });
    for (const prompt of [
      { ...savedPrompts[0], text: "  " },
      { ...savedPrompts[0], behavior: "run" },
    ]) {
      expect(() => decodeServerSettingsPatch({ savedPrompts: [prompt] })).toThrow();
    }
  });
});

describe("resolveProjectProviderInstanceEnabled", () => {
  const projectId = "project-a" as ProjectId;
  const instanceId = ProviderInstanceId.make("codex_work");

  it("lets a project disable an instance the machine enabled", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    };
    expect(resolveProjectProviderInstanceEnabled(settings, projectId, instanceId)).toBe(false);
  });
});

describe("requiredScopesForProjectMutation", () => {
  it("adds the settings scope only when a mutation carries scripts", () => {
    const projectId = "project-1" as ProjectId;
    const commandId = "command-1" as CommandId;
    expect(
      requiredScopesForProjectMutation({ type: "project.update", commandId, projectId }),
    ).toEqual(["orchestration:operate"]);
    expect(
      requiredScopesForProjectMutation({
        type: "project.update",
        commandId,
        projectId,
        scripts: [],
      }),
    ).toEqual(["orchestration:operate", "settings:write"]);
  });
});

describe("server model preferences", () => {
  it("distinguishes unmigrated lists from deliberately cleared lists", () => {
    expect(decodeServerSettings({})).toMatchObject({
      favorites: null,
      providerModelPreferences: null,
    });
    const input = { favorites: [], providerModelPreferences: {} };
    expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
    expect(decodeServerSettingsPatch(input)).toEqual(input);
  });
});

describe("notification policy compatibility", () => {
  it("defaults notifications off while preserving reserved preferences for a policy rollback", () => {
    expect(decodeClientSettings({}).notificationMode).toBe("off");
    for (const enabled of [false, true]) {
      const reserved = { appIconUnreadBadgeEnabled: enabled, sessionFinishSoundEnabled: enabled };
      const decoded = decodeClientSettings(reserved);
      expect(decoded.notificationMode).toBe("off");
      expect(encodeClientSettings(decoded)).toMatchObject(reserved);
      expect(decodeClientSettingsPatch(reserved)).toEqual(reserved);
    }
  });
});
