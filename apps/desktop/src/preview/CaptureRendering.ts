// @effect-diagnostics nodeBuiltinImport:off - Native CDP Promise callbacks have no Effect service context.
import { DESKTOP_PREVIEW_RENDERING_LEASE } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";

/** A disconnected capture must not leave its guest painting behind the app. */
export async function withCaptureRendering<A>(
  guest: Electron.WebContents,
  capture: () => Promise<A>,
  signal: AbortSignal,
): Promise<A> {
  const host = guest.hostWebContents;
  if (!host) return capture();
  const token = NodeCrypto.randomUUID();
  // The hook is async; compare its resolved result, not its Promise.
  const request = (active: boolean) =>
    host.executeJavaScript(
      `Promise.resolve(globalThis[${JSON.stringify(DESKTOP_PREVIEW_RENDERING_LEASE)}]?.(${guest.id}, ${JSON.stringify(token)}, ${active})).then(value => value === true)`,
    );
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("Browser capture was cancelled."));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    signal.throwIfAborted();
    const ready = await Promise.race([request(true), cancelled]);
    if (!ready) throw new Error("The browser capture renderer is unavailable.");
    signal.throwIfAborted();
    return await Promise.race([capture(), cancelled]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    if (!host.isDestroyed()) await request(false).catch(() => {});
  }
}
