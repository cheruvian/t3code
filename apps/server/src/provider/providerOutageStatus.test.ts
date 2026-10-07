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

it.effect(
  "filters unrelated OpenAI incidents while retaining every incident for the compact indicator",
  () =>
    resolveProviderOutageAdvisory(ProviderDriverKind.make("codex")).pipe(
      Effect.tap((advisory) =>
        Effect.sync(() => {
          assert.strictEqual(advisory.severity, "none");
          assert.isNull(advisory.message);
          assert.strictEqual(advisory.incidents?.length, 2);
          assert.isFalse(advisory.incidents?.[0]?.affectsProvider);
        }),
      ),
      Effect.provideService(ProviderOutageStatusCache, new Map()),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                status: { indicator: "major", description: "Partial System Outage" },
                components: [{ id: "responses", name: "Responses", status: "operational" }],
                incidents: [
                  {
                    id: "images",
                    name: "Images API errors",
                    status: "investigating",
                    impact: "major",
                    components: [{ id: "images", name: "Images", status: "partial_outage" }],
                    incident_updates: [{ body: "Investigating image requests" }],
                  },
                  {
                    id: "desktop",
                    name: "Unable to create ChatGPT Work desktop threads",
                    status: "identified",
                    impact: "major",
                  },
                  { id: "resolved", name: "Codex errors", status: "resolved", impact: "major" },
                ],
              }),
            ),
          ),
        ),
      ),
    ),
);

it.effect("includes Responses API and Codex incidents in the provider warning", () =>
  resolveProviderOutageAdvisory(ProviderDriverKind.make("codex")).pipe(
    Effect.tap((advisory) =>
      Effect.sync(() => {
        assert.strictEqual(advisory.severity, "outage");
        assert.strictEqual(advisory.message, "Responses API errors; Codex elevated errors");
        assert.strictEqual(advisory.incidents?.length, 2);
        assert.isTrue(advisory.incidents?.every((incident) => incident.affectsProvider));
      }),
    ),
    Effect.provideService(ProviderOutageStatusCache, new Map()),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              status: { indicator: "major" },
              incidents: [
                {
                  id: "responses",
                  name: "Responses API errors",
                  status: "monitoring",
                  impact: "major",
                  components: [{ id: "responses", name: "Responses", status: "partial_outage" }],
                },
                {
                  id: "codex",
                  name: "Codex elevated errors",
                  status: "investigating",
                  impact: "minor",
                },
              ],
            }),
          ),
        ),
      ),
    ),
  ),
);

it.effect("reports a degraded relevant component before an incident is published", () =>
  resolveProviderOutageAdvisory(ProviderDriverKind.make("codex")).pipe(
    Effect.tap((advisory) =>
      Effect.sync(() => {
        assert.strictEqual(advisory.severity, "degraded");
        assert.strictEqual(advisory.message, "Responses: degraded performance");
      }),
    ),
    Effect.provideService(ProviderOutageStatusCache, new Map()),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              status: { indicator: "minor" },
              components: [{ id: "responses", name: "Responses", status: "degraded_performance" }],
              incidents: [],
            }),
          ),
        ),
      ),
    ),
  ),
);

it.effect("does not use OpenAI's unscoped aggregate as a Codex warning", () =>
  resolveProviderOutageAdvisory(ProviderDriverKind.make("codex")).pipe(
    Effect.tap((advisory) =>
      Effect.sync(() => {
        assert.strictEqual(advisory.severity, "none");
        assert.isNull(advisory.message);
        assert.strictEqual(advisory.incidents?.length, 1);
        assert.isFalse(advisory.incidents?.[0]?.affectsProvider);
      }),
    ),
    Effect.provideService(ProviderOutageStatusCache, new Map()),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              status: { indicator: "major", description: "Partial System Outage" },
            }),
          ),
        ),
      ),
    ),
  ),
);
