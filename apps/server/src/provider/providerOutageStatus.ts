import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderOutageAdvisory,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

const OUTAGE_STATUS_TIMEOUT_MS = 4_000;
const OUTAGE_STATUS_CACHE_TTL_MS = 4 * 60 * 1_000;

/**
 * Statuspage.io pages published by drivers that run as an actual hosted
 * service. OpenCode and Antigravity are agent/routing layers over other
 * backends rather than services with their own uptime, so they are
 * intentionally absent here and never get an `outageAdvisory`.
 */
const STATUS_PAGE_SUMMARY_URLS: Partial<Record<ProviderDriverKind, string>> = {
  [ProviderDriverKind.make("codex")]: "https://status.openai.com/api/v2/summary.json",
  [ProviderDriverKind.make("claudeAgent")]: "https://status.anthropic.com/api/v2/summary.json",
  [ProviderDriverKind.make("cursor")]: "https://status.cursor.com/api/v2/summary.json",
  [ProviderDriverKind.make("grok")]: "https://status.x.ai/api/v2/summary.json",
};

const STATUS_PAGE_URLS: Partial<Record<ProviderDriverKind, string>> = {
  [ProviderDriverKind.make("codex")]: "https://status.openai.com",
  [ProviderDriverKind.make("claudeAgent")]: "https://status.anthropic.com",
  [ProviderDriverKind.make("cursor")]: "https://status.cursor.com",
  [ProviderDriverKind.make("grok")]: "https://status.x.ai",
};

const StatuspageIndicator = Schema.Literals(["none", "minor", "major", "critical"]);

const StatuspageSummaryResponse = Schema.Struct({
  status: Schema.Struct({
    indicator: StatuspageIndicator,
    description: Schema.optional(Schema.String),
  }),
});

interface ProviderOutageCacheEntry {
  readonly expiresAt: number;
  readonly advisory: ServerProviderOutageAdvisory;
}

export const ProviderOutageStatusCache = Context.Reference<
  Map<ProviderDriverKind, ProviderOutageCacheEntry>
>("@t3tools/server/providerOutageStatus/ProviderOutageStatusCache", {
  defaultValue: () => new Map(),
});

function severityFromIndicator(
  indicator: typeof StatuspageIndicator.Type,
): ServerProviderOutageAdvisory["severity"] {
  switch (indicator) {
    case "none":
      return "none";
    case "minor":
      return "degraded";
    case "major":
    case "critical":
      return "outage";
  }
}

const fetchStatuspageSummary = Effect.fn("fetchStatuspageSummary")(function* (
  driver: ProviderDriverKind,
  summaryUrl: string,
) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(summaryUrl).pipe(
    HttpClientRequest.setHeader("accept", "application/json"),
  );
  const response = yield* client.execute(request).pipe(
    Effect.timeoutOption(OUTAGE_STATUS_TIMEOUT_MS),
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isNone(response)) {
    return null;
  }
  const httpResponse = response.value;
  if (httpResponse.status < 200 || httpResponse.status >= 300) {
    return null;
  }
  return yield* httpResponse.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(StatuspageSummaryResponse)),
    Effect.orElseSucceed(() => null),
    Effect.catchCause((cause) =>
      Effect.logWarning("Provider outage status fetch failed", {
        driver,
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.as(null)),
    ),
  );
});

/**
 * Resolves upstream service-outage status for a driver from its Statuspage.io
 * page, cached briefly so repeated `enrichSnapshot` calls within the same
 * health-refresh cycle don't refetch. A failed or timed-out poll never blocks
 * or degrades the provider snapshot; it just falls back to `severity: "none"`.
 */
export const resolveProviderOutageAdvisory = Effect.fn("resolveProviderOutageAdvisory")(function* (
  driver: ProviderDriverKind,
) {
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const cache = yield* ProviderOutageStatusCache;
  const cached = cache.get(driver);
  if (cached && cached.expiresAt > now) {
    return cached.advisory;
  }

  const summaryUrl = STATUS_PAGE_SUMMARY_URLS[driver];
  const fallback: ServerProviderOutageAdvisory = {
    severity: "none",
    message: null,
    statusPageUrl: STATUS_PAGE_URLS[driver] ?? null,
    checkedAt,
  };
  if (!summaryUrl) {
    return fallback;
  }

  const summary = yield* fetchStatuspageSummary(driver, summaryUrl);
  const advisory: ServerProviderOutageAdvisory = summary
    ? {
        severity: severityFromIndicator(summary.status.indicator),
        message: summary.status.description?.trim() || null,
        statusPageUrl: STATUS_PAGE_URLS[driver] ?? null,
        checkedAt,
      }
    : fallback;

  cache.set(driver, { expiresAt: now + OUTAGE_STATUS_CACHE_TTL_MS, advisory });
  return advisory;
});

/** Attaches `outageAdvisory` to a snapshot for the drivers we can poll a status page for. */
export const enrichProviderSnapshotWithOutageAdvisory = Effect.fn(
  "enrichProviderSnapshotWithOutageAdvisory",
)(function* (snapshot: ServerProvider) {
  if (!(snapshot.driver in STATUS_PAGE_SUMMARY_URLS)) {
    return snapshot;
  }
  const outageAdvisory = yield* resolveProviderOutageAdvisory(snapshot.driver);
  return { ...snapshot, outageAdvisory };
});
