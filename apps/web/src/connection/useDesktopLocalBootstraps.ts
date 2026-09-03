import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { readDesktopSecondaryBootstraps, refreshDesktopSecondaryBootstraps } from "./desktopLocal";

const DESKTOP_LOCAL_BOOTSTRAP_POLL_MS = 2_000;

/**
 * Reactively track the desktop's secondary local backends (e.g. a parallel WSL
 * backend). The bridge exposes no change event, so we re-read on an interval;
 * failed reads retain the latest successful snapshot, while a successful empty
 * read clears it. Use this instead of polling the bridge ad hoc so every
 * renderer consumer reads the same topology.
 */
export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  const [bootstraps, setBootstraps] = useState<ReadonlyArray<DesktopEnvironmentBootstrap>>(
    readDesktopSecondaryBootstraps,
  );

  useEffect(() => {
    if (window.desktopBridge?.getLocalEnvironmentBootstraps === undefined) return;
    let interval: number | undefined;
    let disposed = false;
    const read = () => {
      void refreshDesktopSecondaryBootstraps().then(() => {
        if (disposed) return;
        const next = readDesktopSecondaryBootstraps();
        setBootstraps((current) =>
          current.length === next.length &&
          current.every((entry, index) => entry.id === next[index]?.id)
            ? current
            : next,
        );
      });
    };
    const sync = () => {
      if (interval !== undefined) window.clearInterval(interval);
      interval = undefined;
      if (document.visibilityState !== "visible") return;
      read();
      interval = window.setInterval(read, DESKTOP_LOCAL_BOOTSTRAP_POLL_MS);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      disposed = true;
      if (interval !== undefined) window.clearInterval(interval);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  return bootstraps;
}
