import { DESKTOP_PREVIEW_CREDENTIAL_ENTRY } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { installBrowserCredentialEntry } from "./browserCredentialEntry";

afterEach(() => vi.unstubAllGlobals());
it("acknowledges hidden guest layout and keeps it hidden if the host unmounts mid-entry", async () => {
  const styles: Array<{ textContent: string; remove: () => void }> = [];
  const attributes = new Map<string, string>();
  const guest = {
    getWebContentsId: () => 7,
    isConnected: true,
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    removeAttribute: (key: string) => attributes.delete(key),
  };
  const paints: Array<() => void> = [];
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => paints.push(callback));
  vi.stubGlobal("document", {
    querySelectorAll: () => [guest],
    createElement: () => ({ textContent: "", remove: vi.fn() }),
    head: { append: (style: (typeof styles)[number]) => styles.push(style) },
  });
  const dispose = installBrowserCredentialEntry();
  const request = (
    globalThis as unknown as Record<string, (id: number, active: boolean) => Promise<boolean>>
  )[DESKTOP_PREVIEW_CREDENTIAL_ENTRY]!;
  const hidden = request(7, true);
  expect(styles[0]?.textContent).toContain("visibility: hidden !important");
  expect(attributes.has("data-credential-entry")).toBe(true);
  paints.splice(0).forEach((paint) => paint());
  expect(await hidden).toBe(true);
  dispose();
  expect(styles[0]?.remove).not.toHaveBeenCalled();
  expect(attributes.has("data-credential-entry")).toBe(true);
  expect(await request(99, true)).toBe(false);
  const released = request(7, false);
  paints.splice(0).forEach((paint) => paint());
  expect(await released).toBe(true);
  expect(styles[0]?.remove).toHaveBeenCalledOnce();
});
