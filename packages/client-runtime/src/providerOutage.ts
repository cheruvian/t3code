// @effect-diagnostics globalTimers:off globalDate:off - Client preference expiry runs outside an Effect runtime.
import type { ServerProvider } from "@t3tools/contracts";

export const PROVIDER_OUTAGE_DISMISSAL_MS = 60 * 60 * 1_000;
export const PROVIDER_OUTAGE_STORAGE_KEY = "t3code.provider-outage-dismissals";

/** Upstream outages belong to a driver, so all its configured instances share dismissal. */
export function getProviderOutageBannerKey(status: ServerProvider | null): string | null {
  return status?.outageAdvisory && status.outageAdvisory.severity !== "none" ? status.driver : null;
}

/** Client-local preference store. A single expiry timer runs only while subscribed. */
export function createProviderOutageDismissals(storage?: {
  read: () => string | null;
  write: (value: string) => void;
}) {
  let deadlines: Readonly<Record<string, number>> = {};
  try {
    const decoded: unknown = JSON.parse(storage?.read() ?? "{}");
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      deadlines = Object.fromEntries(
        Object.entries(decoded).filter(
          ([, value]) => typeof value === "number" && Number.isFinite(value) && value > Date.now(),
        ),
      );
    }
  } catch {
    /* Unavailable storage keeps the preference in memory. */
  }
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = undefined;
    const next = Math.min(...Object.values(deadlines));
    if (!listeners.size || !Number.isFinite(next)) return;
    timer = setTimeout(
      () => {
        deadlines = Object.fromEntries(
          Object.entries(deadlines).filter(([, until]) => until > Date.now()),
        );
        notify();
        schedule();
      },
      Math.max(0, next - Date.now()),
    );
  };
  return {
    getSnapshot: () => {
      if (Object.values(deadlines).some((until) => until <= Date.now())) {
        deadlines = Object.fromEntries(
          Object.entries(deadlines).filter(([, until]) => until > Date.now()),
        );
      }
      return deadlines;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      schedule();
      return () => {
        listeners.delete(listener);
        schedule();
      };
    },
    dismiss: (driver: string) => {
      const now = Date.now();
      deadlines = {
        ...Object.fromEntries(Object.entries(deadlines).filter(([, until]) => until > now)),
        [driver]: now + PROVIDER_OUTAGE_DISMISSAL_MS,
      };
      try {
        storage?.write(JSON.stringify(deadlines));
      } catch {
        /* Keep the in-memory dismissal. */
      }
      notify();
      schedule();
    },
  };
}

/** Deduplicate upstream incidents repeated across instances and connected environments. */
export function getProviderOutageIncidents(providers: ReadonlyArray<ServerProvider>) {
  const unique = new Map<
    string,
    {
      id: string;
      providerName: string;
      name: string;
      message: string | null;
      severity: "none" | "degraded" | "outage";
      affectsProvider: boolean;
      statusPageUrl: string | null;
    }
  >();
  const latestByDriver = new Map<string, ServerProvider>();
  for (const provider of providers) {
    if (!provider.enabled || !provider.outageAdvisory) continue;
    const previous = latestByDriver.get(provider.driver);
    if (
      !previous?.outageAdvisory ||
      provider.outageAdvisory.checkedAt > previous.outageAdvisory.checkedAt
    ) {
      latestByDriver.set(provider.driver, provider);
    }
  }
  for (const provider of latestByDriver.values()) {
    const advisory = provider.outageAdvisory;
    if (!advisory) continue;
    const incidents =
      advisory.incidents ??
      (advisory.severity !== "none"
        ? [
            {
              id: "summary",
              name: advisory.message ?? "Service disruption",
              message: null,
              severity: advisory.severity,
              affectsProvider: true,
            },
          ]
        : []);
    for (const incident of incidents) {
      const id = `${provider.driver}:${incident.id}`;
      if (!unique.has(id))
        unique.set(id, {
          ...incident,
          id,
          providerName:
            provider.driver === "codex"
              ? "OpenAI"
              : provider.displayName?.trim() || provider.driver,
          statusPageUrl: advisory.statusPageUrl,
        });
    }
  }
  return [...unique.values()];
}
