import {
  createProviderOutageDismissals,
  getProviderOutageBannerKey,
  PROVIDER_OUTAGE_STORAGE_KEY,
} from "@t3tools/client-runtime/provider-outage";
import type { ServerProvider } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import * as SecureStore from "expo-secure-store";

const dismissals = createProviderOutageDismissals({
  read: () => SecureStore.getItem(PROVIDER_OUTAGE_STORAGE_KEY),
  write: (value) => SecureStore.setItem(PROVIDER_OUTAGE_STORAGE_KEY, value),
});

export function useProviderOutage(status: ServerProvider | null) {
  const deadlines = useSyncExternalStore(dismissals.subscribe, dismissals.getSnapshot);
  const key = getProviderOutageBannerKey(status);
  return {
    visibleStatus: key !== null && deadlines[key] === undefined ? status : null,
    dismiss: () => {
      if (key !== null) dismissals.dismiss(key);
    },
  };
}
