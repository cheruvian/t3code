import { useEffect, useMemo, useRef } from "react";

import { unreadDoneThreadKeys, shouldPlaySessionFinishSound } from "./attentionBadge";
import { useAllEnvironmentShellsBootstrapped, useThreadShells } from "./state/entities";
import { useUiStateStore } from "./uiStateStore";
import { useClientSettings, useClientSettingsHydrated } from "./hooks/useSettings";
import { playSessionFinishSound } from "./sessionFinishSound";

export function useAttentionSignals(): void {
  const shells = useThreadShells();
  const shellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const settingsHydrated = useClientSettingsHydrated();
  const { appIconUnreadBadgeEnabled, sessionFinishSoundEnabled } = useClientSettings();
  const lastVisitedByKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const unreadDoneKeys = useMemo(
    () => unreadDoneThreadKeys(shells, lastVisitedByKey),
    [lastVisitedByKey, shells],
  );
  const previousKeysRef = useRef<ReadonlySet<string>>(new Set());
  const initializedRef = useRef(false);
  const lastBadgeCountRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!shellsBootstrapped || !settingsHydrated) return;

    if (
      shouldPlaySessionFinishSound(
        previousKeysRef.current,
        unreadDoneKeys,
        sessionFinishSoundEnabled,
        initializedRef.current,
      )
    ) {
      void playSessionFinishSound();
    }

    previousKeysRef.current = unreadDoneKeys;
    initializedRef.current = true;

    const badgeCount = appIconUnreadBadgeEnabled ? unreadDoneKeys.size : 0;
    if (badgeCount === lastBadgeCountRef.current) return;
    lastBadgeCountRef.current = badgeCount;
    void window.desktopBridge?.setBadgeCount?.(badgeCount).catch(() => {
      // Older or unsupported desktop shells fail soft; the web client has no
      // app-icon badge surface of its own.
    });
  }, [
    appIconUnreadBadgeEnabled,
    sessionFinishSoundEnabled,
    settingsHydrated,
    shellsBootstrapped,
    unreadDoneKeys,
  ]);
}
