import { NotificationMode } from "./settings.ts";
import * as Schema from "effect/Schema";

export const WebPushSubscription = Schema.Struct({
  endpoint: Schema.String.check(Schema.isMaxLength(4096)),
  keys: Schema.Struct({
    p256dh: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{87}$/)),
    auth: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/)),
  }),
});
export type WebPushSubscription = typeof WebPushSubscription.Type;

export const WebPushUpdate = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("subscribe"),
    subscription: WebPushSubscription,
    notificationMode: NotificationMode,
  }),
  Schema.Struct({ type: Schema.Literal("unsubscribe"), endpoint: Schema.String }),
]);
export type WebPushUpdate = typeof WebPushUpdate.Type;

export class WebPushError extends Schema.TaggedError<WebPushError>()("WebPushError", {
  reason: Schema.Literals([
    "storage",
    "invalid-subscription",
    "limit",
    "delivery",
    "invalid-message",
  ]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "storage":
        return "Could not save background push settings.";
      case "invalid-subscription":
        return "This browser's push subscription is not supported.";
      case "limit":
        return "This environment has too many push subscriptions.";
      case "invalid-message":
        return "Notification content or link is invalid, or the payload exceeds 3500 bytes.";
      case "delivery":
        return "Could not send the push notification.";
    }
  }
}

const NotificationLink = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((value) => {
    try {
      if (
        value.startsWith("/") &&
        !value.startsWith("//") &&
        !value.includes("\\") &&
        !Array.from(value).some((character) => character.charCodeAt(0) < 32)
      )
        return new URL(value, "https://t3.invalid").origin === "https://t3.invalid";
      const url = new URL(value);
      return (
        /^https:\/\//i.test(value) && url.protocol === "https:" && !url.username && !url.password
      );
    } catch {
      return false;
    }
  }),
);

export const NotificationSendInput = Schema.Struct({
  title: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(120),
    Schema.isPattern(/\S/),
  ),
  body: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(2000),
    Schema.isPattern(/\S/),
  ),
  url: Schema.optionalKey(NotificationLink),
  tag: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
  idempotencyKey: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  ),
});
export type NotificationSendInput = typeof NotificationSendInput.Type;

export const NotificationSendResult = Schema.Struct({
  subscribed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sent: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  failed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  expired: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  skipped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type NotificationSendResult = typeof NotificationSendResult.Type;
