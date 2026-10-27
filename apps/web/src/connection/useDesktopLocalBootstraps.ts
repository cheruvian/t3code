import { useAtomValue } from "@effect/atom-react";
import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { readDesktopSecondaryBootstraps, refreshDesktopSecondaryBootstraps } from "./desktopLocal";

const DESKTOP_LOCAL_BOOTSTRAP_POLL_MS = 2_000;

/**
 * The bridge exposes no change event, so this re-reads on an interval while
 * anything reads it; failed reads retain the latest successful snapshot, while
 * a successful empty read clears it. The reader returns the same array while
 * nothing changed, so an unchanged poll notifies no one.
 */
const desktopLocalBootstrapsAtom = Atom.make((get) => {
  let disposed = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  const read = () => {
    void refreshDesktopSecondaryBootstraps().then(() => {
      if (!disposed) get.setSelf(readDesktopSecondaryBootstraps());
    });
  };
  const sync = () => {
    if (interval !== undefined) clearInterval(interval);
    interval = undefined;
    if (document.visibilityState !== "visible") return;
    read();
    interval = setInterval(read, DESKTOP_LOCAL_BOOTSTRAP_POLL_MS);
  };
  sync();
  document.addEventListener("visibilitychange", sync);
  get.addFinalizer(() => {
    disposed = true;
    if (interval !== undefined) clearInterval(interval);
    document.removeEventListener("visibilitychange", sync);
  });
  return readDesktopSecondaryBootstraps();
}).pipe(Atom.withLabel("desktop-local-bootstraps"));

export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return useAtomValue(desktopLocalBootstrapsAtom);
}
