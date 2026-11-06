import { describe, expect, it, vi } from "vite-plus/test";

import * as PreviewManager from "./Manager.ts";

describe("fitPictureInPictureContentSize", () => {
  it("preserves the PiP content area across aspect-ratio changes", () => {
    expect(PreviewManager.fitPictureInPictureContentSize([480, 320], 16 / 9)).toEqual([523, 294]);
    expect(PreviewManager.fitPictureInPictureContentSize([480, 320], 9 / 16)).toEqual([294, 523]);
  });
});

describe("recordingFileExtension", () => {
  it("derives the artifact extension from the recorder's actual mime type", () => {
    expect(PreviewManager.recordingFileExtension("video/mp4;codecs=avc1.640028")).toBe("mp4");
    expect(PreviewManager.recordingFileExtension("video/webm;codecs=vp9")).toBe("webm");
    expect(PreviewManager.recordingFileExtension("video/x-matroska")).toBe("matroska");
  });
});

describe("isPreviewRefreshShortcut", () => {
  const input = (overrides: Partial<Electron.Input> = {}) =>
    ({
      type: "keyDown",
      key: "r",
      meta: true,
      control: false,
      shift: false,
      alt: false,
      ...overrides,
    }) as Electron.Input;

  it("recognizes the platform refresh chord without matching modified variants", () => {
    expect(PreviewManager.isPreviewRefreshShortcut(input(), "darwin")).toBe(true);
    expect(
      PreviewManager.isPreviewRefreshShortcut(input({ meta: false, control: true }), "win32"),
    ).toBe(true);
    expect(PreviewManager.isPreviewRefreshShortcut(input({ shift: true }), "darwin")).toBe(false);
    expect(PreviewManager.isPreviewRefreshShortcut(input({ type: "keyUp" }), "darwin")).toBe(false);
  });
});

describe("isPreviewEditingShortcut", () => {
  const input = (platform: NodeJS.Platform, key: string, overrides: Partial<Electron.Input> = {}) =>
    ({
      type: "keyDown",
      key,
      meta: platform === "darwin",
      control: platform !== "darwin",
      shift: false,
      alt: false,
      ...overrides,
    }) as Electron.Input;

  it.each(["darwin", "linux", "win32"] as const)(
    "allows native editing chords on %s without allowing host shortcuts",
    (platform) => {
      for (const key of ["a", "c", "v", "x", "z", "V"]) {
        expect(PreviewManager.isPreviewEditingShortcut(input(platform, key), platform)).toBe(true);
      }
      const redo =
        platform === "win32" ? input(platform, "y") : input(platform, "z", { shift: true });
      expect(PreviewManager.isPreviewEditingShortcut(redo, platform)).toBe(true);
      expect(
        PreviewManager.isPreviewEditingShortcut(
          input(platform, "v", { shift: true, alt: platform === "darwin" }),
          platform,
        ),
      ).toBe(true);

      for (const key of ["k", ",", "w", "j", "q", "+", "=", "-", "0", "r", "F12"]) {
        expect(PreviewManager.isPreviewEditingShortcut(input(platform, key), platform)).toBe(false);
      }
      for (const modifiers of [
        { meta: false, control: false },
        { meta: true, control: true },
        { meta: platform !== "darwin", control: platform === "darwin" },
        { alt: true },
        { shift: true, alt: platform !== "darwin" },
      ]) {
        expect(
          PreviewManager.isPreviewEditingShortcut(input(platform, "v", modifiers), platform),
        ).toBe(false);
      }
      expect(
        PreviewManager.isPreviewEditingShortcut(input(platform, "a", { shift: true }), platform),
      ).toBe(false);
    },
  );
});

describe("previewWindowOpenAction", () => {
  const details = (overrides: {
    readonly url?: string;
    readonly disposition?: Electron.HandlerDetails["disposition"];
  }) => ({
    url: "https://accounts.google.com/o/oauth2/auth",
    disposition: "new-window" as Electron.HandlerDetails["disposition"],
    ...overrides,
  });

  it("opens target=_blank links as a new tab", () => {
    expect(PreviewManager.previewWindowOpenAction(details({ disposition: "foreground-tab" }))).toBe(
      "new-tab",
    );
    expect(PreviewManager.previewWindowOpenAction(details({ disposition: "background-tab" }))).toBe(
      "new-tab",
    );
  });
});

const {
  browserWindowConstructor,
  clipboardItemConstructor,
  createFromPath,
  fromId,
  getFocusedWebContents,
  showItemInFolder,
  writeClipboard,
} = vi.hoisted(() => ({
  browserWindowConstructor: vi.fn(),
  clipboardItemConstructor: vi.fn(),
  createFromPath: vi.fn((): { readonly isEmpty: () => boolean; readonly toPNG: () => Buffer } => ({
    isEmpty: () => false,
    toPNG: () => Buffer.from("png"),
  })),
  fromId: vi.fn<(_id?: number) => Electron.WebContents | null>((_id?: number) => null),
  getFocusedWebContents: vi.fn(() => null),
  mkdir: vi.fn((_path: string) => undefined),
  previewSession: { on: vi.fn() },
  showItemInFolder: vi.fn(),
  webviewSend: vi.fn(),
  writeFile: vi.fn((_path: string, _data: Uint8Array) => undefined),
  writeClipboard: vi.fn(async () => undefined),
}));

vi.mock("electron", () => ({
  BrowserWindow: browserWindowConstructor,
  ClipboardItem: vi.fn(function (data: Record<string, unknown>) {
    clipboardItemConstructor(data);
  }),
  clipboard: {
    write: writeClipboard,
  },
  nativeImage: {
    createFromPath,
  },
  shell: {
    showItemInFolder,
  },
  session: {
    fromPartition: vi.fn(),
  },
  webContents: {
    fromId,
    getFocusedWebContents,
  },
}));

describe("PreviewOperationError", () => {
  it("keeps timeline detail separate from its structured message", () => {
    const cause = new Error("CDP command failed with an invalid node id");
    const error = new PreviewManager.PreviewOperationError({
      operation: "click.DOM.resolveNode",
      tabId: "tab_1",
      webContentsId: 42,
      cause,
    });

    expect(error.message).not.toContain(cause.message);
    expect(PreviewManager.PreviewOperationError.toTimelineMessage(error)).toBe(cause.message);
  });
});
