import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentHttpApi,
  type AuthEnvironmentScope,
  type NotificationSendInput,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as AuthHttp from "../auth/http.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as WebPush from "./WebPush.ts";
import * as NotificationHttp from "./http.ts";

class NotificationTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.notifications,
) {}

async function sendRequest(body: unknown, scopes: readonly AuthEnvironmentScope[] | null) {
  const delivered: NotificationSendInput[] = [];
  const routes = HttpApiBuilder.layer(NotificationTestApi).pipe(
    Layer.provide(NotificationHttp.layer),
    Layer.provide(
      Layer.mock(WebPush.WebPush)({
        send: (input) =>
          Effect.sync(() => {
            delivered.push(input);
            return { subscribed: 2, sent: 2, failed: 0, expired: 0, skipped: 0 };
          }),
      }),
    ),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provide(
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        authenticateHttpRequest: () =>
          scopes === null
            ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}))
            : Effect.succeed({
                sessionId: AuthSessionId.make("test-session"),
                subject: "test",
                method: "bearer-access-token" as const,
                scopes,
              }),
      }),
    ),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  try {
    const response = await handler(
      new Request("https://t3.example/api/notifications/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const text = await response.text();
    return {
      status: response.status,
      body: text ? (JSON.parse(text) as unknown) : null,
      delivered,
    };
  } finally {
    await dispose();
  }
}

describe("notification send HTTP API", () => {
  it("accepts authenticated notification content and returns delivery counts", async () => {
    const message = {
      title: "Backup complete",
      body: "Files archived",
      url: "https://example.com/backups/42",
      idempotencyKey: "backup-42",
    };
    const response = await sendRequest(message, [AuthOrchestrationOperateScope]);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ subscribed: 2, sent: 2, failed: 0, expired: 0, skipped: 0 });
    expect(response.delivered).toEqual([message]);
  });
  it.each([
    { scopes: null, status: 401 },
    { scopes: [AuthOrchestrationReadScope], status: 403 },
  ])("rejects unauthorized sends with HTTP $status", async ({ scopes, status }) => {
    const response = await sendRequest({ title: "Job", body: "Done" }, scopes);
    expect(response.status).toBe(status);
    expect(response.delivered).toEqual([]);
  });
  it.each([
    { title: "", body: "Done" },
    { title: "Job", body: " " },
    { title: "Job", body: "Done", url: "javascript:alert(1)" },
    { title: "Job", body: "Done", url: "//elsewhere.example/" },
  ])("rejects invalid notification input before sending", async (message) => {
    const response = await sendRequest(message, [AuthOrchestrationOperateScope]);
    expect(response.status).toBe(400);
    expect(response.delivered).toEqual([]);
  });
});
