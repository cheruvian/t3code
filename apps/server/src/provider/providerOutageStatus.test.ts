import { assert, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  ProviderOutageStatusCache,
  resolveProviderOutageAdvisory,
} from "./providerOutageStatus.ts";

it.effect("reports and caches Cursor service outages for the SDK provider", () => {
  let requests = 0;
  return Effect.gen(function* () {
    const first = yield* resolveProviderOutageAdvisory(ProviderDriverKind.make("cursor"));
    const second = yield* resolveProviderOutageAdvisory(ProviderDriverKind.make("cursor"));
    assert.strictEqual(first.severity, "outage");
    assert.strictEqual(first.message, "Service disruption");
    assert.strictEqual(first.statusPageUrl, "https://status.cursor.com");
    assert.deepEqual(second, first);
    assert.strictEqual(requests, 1);
  }).pipe(
    Effect.provideService(ProviderOutageStatusCache, new Map()),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests++;
        assert.strictEqual(request.url, "https://status.cursor.com/api/v2/summary.json");
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              status: { indicator: "major", description: "Service disruption" },
            }),
          ),
        );
      }),
    ),
  );
});

it.effect("keeps provider availability independent from an invalid status response", () =>
  resolveProviderOutageAdvisory(ProviderDriverKind.make("codex")).pipe(
    Effect.tap((advisory) =>
      Effect.sync(() => {
        assert.strictEqual(advisory.severity, "none");
        assert.isNull(advisory.message);
      }),
    ),
    Effect.provideService(ProviderOutageStatusCache, new Map()),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("Unavailable", { status: 503 })),
        ),
      ),
    ),
  ),
);
