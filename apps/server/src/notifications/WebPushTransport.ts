import { WebPushError, type WebPushSubscription } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import webpush from "web-push";

export class WebPushTransport extends Context.Service<
  WebPushTransport,
  {
    readonly generateKeys: Effect.Effect<{ publicKey: string; privateKey: string }>;
    readonly send: (
      subscription: WebPushSubscription,
      payload: string,
      keys: { publicKey: string; privateKey: string },
    ) => Effect.Effect<"sent" | "expired", WebPushError>;
  }
>()("t3/notifications/WebPushTransport") {}

// Restrict authenticated subscription URLs to browser push providers, never arbitrary hosts.
export function isSupportedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      (url.hostname === "fcm.googleapis.com" ||
        url.hostname === "updates.push.services.mozilla.com" ||
        url.hostname === "web.push.apple.com" ||
        url.hostname.endsWith(".notify.windows.com"))
    );
  } catch {
    return false;
  }
}

export const layer = Layer.succeed(WebPushTransport, {
  generateKeys: Effect.sync(() => webpush.generateVAPIDKeys()),
  send: (subscription, payload, keys) =>
    Effect.tryPromise({
      try: () =>
        webpush
          .sendNotification(subscription, payload, {
            vapidDetails: { subject: "https://t3.codes", ...keys },
            TTL: 300,
            urgency: "normal",
            timeout: 10_000,
          })
          .then(() => "sent" as const)
          .catch((cause: unknown) => {
            if (
              typeof cause === "object" &&
              cause !== null &&
              "statusCode" in cause &&
              (cause.statusCode === 404 || cause.statusCode === 410)
            )
              return "expired" as const;
            throw cause;
          }),
      catch: () => new WebPushError({ reason: "delivery" }),
    }),
});
