import { DESKTOP_PREVIEW_CREDENTIAL_ENTRY } from "@t3tools/contracts";

/** Hide native guest pixels, including password-reveal UI, until cleanup is acknowledged. */
export function installBrowserCredentialEntry() {
  const styles = new Map<number, HTMLStyleElement>();
  const request = async (id: number, active: boolean) => {
    const guest = [...document.querySelectorAll("webview")].find((element) => {
      try {
        return element.getWebContentsId() === id;
      } catch {
        return false;
      }
    });
    if (!guest) return false;
    if (active) {
      guest.setAttribute("data-credential-entry", String(id));
      const style = document.createElement("style");
      style.textContent = `webview[data-credential-entry="${id}"] { visibility: hidden !important; pointer-events: none !important; }`;
      document.head.append(style);
      styles.get(id)?.remove();
      styles.set(id, style);
    } else {
      styles.get(id)?.remove();
      styles.delete(id);
      guest.removeAttribute("data-credential-entry");
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return guest.isConnected;
  };
  const host = globalThis as typeof globalThis & {
    [DESKTOP_PREVIEW_CREDENTIAL_ENTRY]?: typeof request;
  };
  host[DESKTOP_PREVIEW_CREDENTIAL_ENTRY] = request;
  return () => {
    if (host[DESKTOP_PREVIEW_CREDENTIAL_ENTRY] === request)
      delete host[DESKTOP_PREVIEW_CREDENTIAL_ENTRY];
    // Native guests stay hidden if the host unmounts mid-entry; native teardown closes them.
  };
}
