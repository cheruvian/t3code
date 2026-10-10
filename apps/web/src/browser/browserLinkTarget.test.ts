import type { BrowserLinkTarget } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ensureClientSettingsHydrated } from "~/hooks/useSettings";

import { resolveBrowserLinkTargetPreference, resolveLinkTarget } from "./browserLinkTarget";

const settings = vi.hoisted(() => ({ browserLinkTarget: "system" as BrowserLinkTarget }));

vi.mock("~/hooks/useSettings", () => ({
  ensureClientSettingsHydrated: vi.fn(async () => undefined),
  getClientSettings: () => settings,
}));

const click = { metaKey: false, ctrlKey: false };

afterEach(() => vi.unstubAllGlobals());

describe("resolveLinkTarget", () => {
  it("keeps the system browser unless the user asked for in-app", () => {
    expect(
      resolveLinkTarget({
        url: "https://example.com/",
        event: click,
        preference: "system",
        canOpenInApp: true,
      }),
    ).toBe("system");
  });

  it.each(["display-mode", "ios"])(
    "keeps Home Screen links in a closable panel using %s detection",
    (detection) => {
      vi.stubGlobal("window", {
        matchMedia: () => ({ matches: detection === "display-mode" }),
        navigator: { standalone: detection === "ios" },
      });
      const input = {
        url: "https://sven.tailf474c0.ts.net:8480/?v=2",
        event: click,
        preference: "system" as const,
        canOpenInApp: true,
      };
      expect(resolveLinkTarget(input)).toBe("app");
      expect(resolveLinkTarget({ ...input, canOpenInApp: false })).toBe("system");
      expect(resolveLinkTarget({ ...input, event: { metaKey: true, ctrlKey: false } })).toBe(
        "system",
      );
      expect(resolveLinkTarget({ ...input, url: "mailto:someone@example.com" })).toBe("system");
    },
  );

  it("opens in-app when asked and the runtime can", () => {
    expect(
      resolveLinkTarget({
        url: "https://example.com/",
        event: click,
        preference: "app",
        canOpenInApp: true,
      }),
    ).toBe("app");
  });

  it("falls back to the system browser where there is no in-app browser", () => {
    // The hosted web app and mobile have nowhere to open a tab, so the
    // preference cannot be honoured there and the link still has to open.
    expect(
      resolveLinkTarget({
        url: "https://example.com/",
        event: click,
        preference: "app",
        canOpenInApp: false,
      }),
    ).toBe("system");
  });

  it("treats a modifier click as the way out of the in-app default", () => {
    expect(
      resolveLinkTarget({
        url: "https://example.com/",
        event: { metaKey: true, ctrlKey: false },
        preference: "app",
        canOpenInApp: true,
      }),
    ).toBe("system");
    expect(
      resolveLinkTarget({
        url: "https://example.com/",
        event: { metaKey: false, ctrlKey: true },
        preference: "app",
        canOpenInApp: true,
      }),
    ).toBe("system");
  });

  it("leaves non-web schemes to the shell", () => {
    for (const url of ["mailto:someone@example.com", "vscode://file/x", "not a url"]) {
      expect(resolveLinkTarget({ url, event: click, preference: "app", canOpenInApp: true })).toBe(
        "system",
      );
    }
  });
});

describe("resolveBrowserLinkTargetPreference", () => {
  it.each(["system", "app"] as const)(
    "rejects failed reads instead of using the current %s preference",
    async (preference) => {
      settings.browserLinkTarget = preference;
      const failure = new Error("Settings read failed");
      vi.mocked(ensureClientSettingsHydrated).mockRejectedValueOnce(failure);

      await expect(resolveBrowserLinkTargetPreference()).rejects.toBe(failure);
      await expect(resolveBrowserLinkTargetPreference()).resolves.toBe(preference);
    },
  );
});
