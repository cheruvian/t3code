import { useEffect, useMemo, useRef } from "react";
import { unreadDoneThreadKeys, shouldPlaySessionFinishSound } from "./attentionBadge";
import { useAllEnvironmentShellsBootstrapped, useThreadShells } from "./state/entities";
import { useUiStateStore } from "./uiStateStore";
import {
  getClientSettings,
  useClientSettings,
  useClientSettingsHydrated,
} from "./hooks/useSettings";
import {
  hasNotificationSound,
  playNotificationSound,
  setNotificationBadge,
  unlockNotificationAudio,
} from "./threadNotifications";

export function AttentionSignals() {
  const shells = useThreadShells();
  const ready = useAllEnvironmentShellsBootstrapped();
  const hydrated = useClientSettingsHydrated();
  const badgeEnabled = useClientSettings((s) => s.appIconUnreadBadgeEnabled);
  const soundEnabled = useClientSettings((s) => s.sessionFinishSoundEnabled);
  const mode = useClientSettings((s) => s.notificationMode);
  const visits = useUiStateStore((s) => s.threadLastVisitedAtById);
  const unread = useMemo(() => unreadDoneThreadKeys(shells, visits), [shells, visits]);
  const previous = useRef<ReadonlySet<string>>(new Set());
  const initialized = useRef(false);
  const badgeCount = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!soundEnabled) return;
    document.addEventListener("pointerdown", unlockNotificationAudio);
    document.addEventListener("keydown", unlockNotificationAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockNotificationAudio);
      document.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [soundEnabled]);

  useEffect(() => {
    if (!ready || !hydrated) {
      initialized.current = false;
      return;
    }
    if (
      shouldPlaySessionFinishSound(
        previous.current,
        unread,
        soundEnabled && !hasNotificationSound(mode),
        initialized.current,
      )
    ) {
      void playNotificationSound(
        "completion",
        () =>
          getClientSettings().sessionFinishSoundEnabled &&
          !hasNotificationSound(getClientSettings().notificationMode),
      );
    }
    previous.current = unread;
    initialized.current = true;
    const count = badgeEnabled ? unread.size : 0;
    if (window.desktopBridge && badgeCount.current !== count) {
      badgeCount.current = count;
      setNotificationBadge(count, true);
    }
  }, [ready, hydrated, unread, badgeEnabled, soundEnabled, mode]);
  return null;
}
