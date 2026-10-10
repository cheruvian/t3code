// @effect-diagnostics globalDate:off - Tests exercise persisted wall-clock expiry with fake timers.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import {
  createProviderOutageDismissals,
  getProviderOutageBannerKey,
  getProviderOutageIncidents,
  PROVIDER_OUTAGE_DISMISSAL_MS,
} from "./providerOutage.ts";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex-work"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-07T00:00:00Z",
  models: [],
  skills: [],
  slashCommands: [],
  outageAdvisory: {
    severity: "outage",
    message: "Responses unavailable",
    statusPageUrl: "https://status.openai.com",
    checkedAt: "2026-10-07T00:00:00Z",
  },
};

afterEach(() => vi.useRealTimers());

describe("provider outage dismissal", () => {
  it("persists across instances and reloads, expires at one hour, and leaves other providers visible", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T00:00:00Z"));
    let saved: string | null = null;
    const storage = {
      read: () => saved,
      write: (value: string) => {
        saved = value;
      },
    };
    const store = createProviderOutageDismissals(storage);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const key = getProviderOutageBannerKey(provider)!;
    store.dismiss(key);
    const otherInstance = {
      ...provider,
      instanceId: ProviderInstanceId.make("codex-personal"),
      outageAdvisory: { ...provider.outageAdvisory!, message: "New incident" },
    };
    expect(getProviderOutageBannerKey(otherInstance)).toBe(key);
    expect(createProviderOutageDismissals(storage).getSnapshot()[key]).toBe(
      Date.now() + PROVIDER_OUTAGE_DISMISSAL_MS,
    );
    expect(store.getSnapshot().claudeAgent).toBeUndefined();
    vi.advanceTimersByTime(PROVIDER_OUTAGE_DISMISSAL_MS - 1);
    expect(store.getSnapshot()[key]).toBeGreaterThan(Date.now());
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot()[key]).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(createProviderOutageDismissals(storage).getSnapshot()).toEqual({});
    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps dismissal functional when storage fails and clears expiry when resubscribed", () => {
    vi.useFakeTimers();
    const store = createProviderOutageDismissals({
      read: () => {
        throw new Error("blocked");
      },
      write: () => {
        throw new Error("full");
      },
    });
    const unsubscribe = store.subscribe(() => {});
    store.dismiss("codex");
    expect(store.getSnapshot().codex).toBeGreaterThan(Date.now());
    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(PROVIDER_OUTAGE_DISMISSAL_MS);
    const stop = store.subscribe(() => {});
    vi.advanceTimersByTime(0);
    expect(store.getSnapshot()).toEqual({});
    stop();
  });
});

it("keeps all incidents available after dismissal, including unrelated OpenAI services, without instance duplicates", () => {
  const status = {
    ...provider,
    outageAdvisory: {
      ...provider.outageAdvisory!,
      severity: "none" as const,
      incidents: [
        {
          id: "images",
          name: "Images unavailable",
          message: "Investigating",
          severity: "outage" as const,
          affectsProvider: false,
        },
        {
          id: "work",
          name: "Desktop threads unavailable",
          message: null,
          severity: "outage" as const,
          affectsProvider: false,
        },
      ],
    },
  };
  expect(getProviderOutageBannerKey(status)).toBeNull();
  expect(
    getProviderOutageIncidents([
      status,
      { ...status, instanceId: ProviderInstanceId.make("codex-other") },
    ]),
  ).toHaveLength(2);
  expect(getProviderOutageIncidents([{ ...status, enabled: false }])).toEqual([]);
});

it("uses the latest upstream poll across environments so recovered incidents do not linger", () => {
  const recovered = {
    ...provider,
    outageAdvisory: {
      ...provider.outageAdvisory!,
      checkedAt: "2026-10-07T00:04:00Z",
      severity: "none" as const,
      message: null,
      incidents: [],
    },
  };
  expect(getProviderOutageIncidents([provider, recovered])).toEqual([]);
  expect(getProviderOutageIncidents([recovered, provider])).toEqual([]);
});
