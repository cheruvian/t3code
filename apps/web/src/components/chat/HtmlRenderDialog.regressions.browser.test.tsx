import { act, render, type Screen } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { htmlRenderTheme, HTML_RENDER_DEFAULT_FONTS } from "@t3tools/shared/htmlRender";
import { T3_CODE_DARK_THEME_COLORS } from "@t3tools/shared/themePalettes";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { HtmlRenderDialog } from "./HtmlRenderDialog";
import { HtmlRenderFrame } from "./HtmlRenderFrame";

const { cachedUrl, refresh, showError, openLink, openChangeRequestLink, settings } = vi.hoisted(
  () => ({
    settings: { htmlPreviewDefaultMode: "inline" },
    cachedUrl: { lifeMs: 60 * 60_000 },
    refresh: vi.fn(),
    showError: vi.fn(),
    openLink: vi.fn(),
    openChangeRequestLink: vi.fn(),
  }),
);
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { htmlPreviewDefaultMode: string }) => unknown) =>
    select(settings),
}));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => openLink }));
vi.mock("~/lib/openPullRequestLink", () => ({
  useOpenChangeRequestLink: () => openChangeRequestLink,
}));
vi.mock("~/assets/assetUrls", async (original) => ({
  ...(await original<typeof import("~/assets/assetUrls")>()),
  useAssetUrlRefresh: () => refresh,
}));
vi.mock("~/assets/longLivedAssetUrls", () => ({
  useLongLivedAssetUrl: () => ({
    _tag: "Success",
    url: "https://environment.test/original.html",
    expiresAt: Date.now() + cachedUrl.lifeMs,
  }),
}));
vi.mock("../ui/toast", async (original) => ({
  ...(await original<typeof import("../ui/toast")>()),
  toastManager: { add: showError },
}));

vi.mock("~/hooks/useHtmlRenderTheme", () => ({
  useHtmlRenderTheme: () =>
    htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark", HTML_RENDER_DEFAULT_FONTS),
}));

const onClose = vi.fn();

async function click(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(() => button!.click());
}

it("zooms the loaded page within bounds and resets without reloading it", async () => {
  using _fixture = setup();
  await using screen = await render(null, { router: false });
  await screen.rerender(
    <HtmlRenderDialog
      src="https://environment.test/page.html"
      htmlRender={{ attachmentId: "diagram", title: "Diagram", height: 400 }}
      onClose={onClose}
    />,
  );
  const frame = document.querySelector("iframe")!;
  const src = frame.src;
  for (let step = 0; step < 6; step += 1) await click("Zoom in");
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.disabled).toBe(true);
  expect(frame.parentElement!.style.getPropertyValue("zoom")).toBe("2");
  for (let step = 0; step < 8; step += 1) await click("Zoom out");
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!.disabled).toBe(true);
  expect(frame.parentElement!.style.getPropertyValue("zoom")).toBe("0.5");
  await click("Reset zoom");
  expect(frame.parentElement!.style.getPropertyValue("zoom")).toBe("1");
  expect(document.querySelector("iframe")).toBe(frame);
  expect(frame.src).toBe(src);
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
});

it("closes with the close button or Escape", async () => {
  using _fixture = setup();
  await using screen = await render(null, { router: false });
  await screen.rerender(
    <HtmlRenderDialog
      src="https://environment.test/page.html"
      htmlRender={{ attachmentId: "diagram", title: "Diagram", height: 400 }}
      onClose={onClose}
    />,
  );
  await click("Close");
  expect(onClose).toHaveBeenCalledOnce();
  onClose.mockClear();
  await act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(onClose).toHaveBeenCalledOnce();
});

async function renderInline(screen: Screen) {
  // Async so a URL minted at mount lands inside act.
  await act(async () =>
    screen.rerender(
      <HtmlRenderFrame
        environmentId={EnvironmentId.make("environment")}
        htmlRender={{ attachmentId: "html", title: "Diagram", height: 400 }}
        threadRef={{
          environmentId: EnvironmentId.make("environment"),
          threadId: ThreadId.make("thread"),
        }}
      />,
    ),
  );
}

it("offers only full screen and opens with the inline URL while keeping the inline page loaded", async () => {
  using _fixture = setup();
  await using screen = await render(null, { router: false });
  await renderInline(screen);
  expect(document.querySelector('[aria-label="Open in panel"]')).toBeNull();
  const inlineFrame = document.querySelector("iframe")!;
  const originalSrc = inlineFrame.src;
  const expandButton = document.querySelector<HTMLButtonElement>(
    '[aria-label="Open full screen"]',
  )!;
  expandButton.focus();
  await click("Open full screen");
  expect(refresh).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"] iframe')?.getAttribute("src")).toContain(
    "https://environment.test/original.html#",
  );
  expect(inlineFrame.src).toBe(originalSrc);
  await click("Close");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector("iframe")).toBe(inlineFrame);
  expect(document.activeElement).toBe(expandButton);
});

async function renderInlineNearExpiry(screen: Screen) {
  cachedUrl.lifeMs = 60_000;
  await renderInline(screen);
}

it("opens full screen with a fresh URL when the inline one is near expiry", async () => {
  using _fixture = setup();
  await using screen = await render(null, { router: false });
  await renderInlineNearExpiry(screen);
  refresh.mockResolvedValue("https://environment.test/renewed.html");
  await click("Open full screen");
  expect(refresh).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="dialog"] iframe')?.getAttribute("src")).toContain(
    "https://environment.test/renewed.html#",
  );
});

it("routes links from the expanded page through its thread", async () => {
  using _fixture = setup();
  await using screen = await render(null, { router: false });
  await renderInline(screen);
  openChangeRequestLink.mockReturnValue(true);
  await click("Open full screen");
  const frame = document.querySelector<HTMLIFrameElement>('[role="dialog"] iframe')!;
  frame.focus();
  const url = "https://github.com/pingdotgg/t3code/pull/17561";
  await act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { jsonrpc: "2.0", id: "link", method: "ui/open-link", params: { url } },
      }),
    );
  });
  expect(openChangeRequestLink).toHaveBeenCalledWith(
    expect.objectContaining({ metaKey: false, ctrlKey: false }),
    url,
    undefined,
    EnvironmentId.make("environment"),
  );
  expect(openLink).not.toHaveBeenCalled();
});

it.each([null, new Error("Disconnected")])(
  "reports an unavailable URL instead of opening a blank page: %s",
  async (failure) => {
    using _fixture = setup();
    await using screen = await render(null, { router: false });
    await renderInlineNearExpiry(screen);
    if (failure === null) refresh.mockResolvedValue(null);
    else refresh.mockRejectedValue(failure);
    await click("Open full screen");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(showError).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Page unavailable" }),
    );
  },
);

it.each(["collapsed", "side-panel"])(
  "respects the %s preference and lets the reader show inline or open the preview",
  async (mode) => {
    using _fixture = setup();
    await using screen = await render(null, { router: false });
    const container = screen.container;
    settings.htmlPreviewDefaultMode = mode;
    const onOpen = vi.fn();
    await act(() =>
      screen.rerender(
        <HtmlRenderFrame
          environmentId={EnvironmentId.make("environment")}
          htmlRender={{ attachmentId: "page", title: "Diagram", height: 300 }}
          threadRef={undefined}
          onOpen={onOpen}
        />,
      ),
    );
    expect(container.querySelector("iframe")).toBeNull();
    const button = (text: string) =>
      [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text))!;
    await act(() => button("Show inline").click());
    expect(container.querySelector("iframe")?.src).toContain("original.html");
    await act(() => button("Open preview").click());
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ id: "page", mimeType: "text/html", htmlRender: true }),
    );
    expect(container.querySelector("iframe")).toBeNull();
    await act(() => button("Show inline").click());
    expect(container.querySelector("iframe")?.src).toContain("original.html");
  },
);

function setup() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  refresh.mockReset();
  cachedUrl.lifeMs = 60 * 60_000;
  settings.htmlPreviewDefaultMode = "inline";
  openLink.mockReset().mockResolvedValue(undefined);
  openChangeRequestLink.mockReset().mockReturnValue(false);
  showError.mockClear();
  onClose.mockClear();

  return {
    [Symbol.dispose]() {
      vi.unstubAllGlobals();
    },
  };
}
