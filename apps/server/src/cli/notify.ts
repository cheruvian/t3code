import { NotificationSendInput } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { projectLocationFlags } from "./config.ts";
import { encodeCliJson, makeEnvironmentHttpClient, withLocalEnvironment } from "./environment.ts";

class NotifyCliError extends Schema.TaggedError<NotifyCliError>()("NotifyCliError", {
  reason: Schema.Literals(["message-source", "no-devices", "delivery"]),
}) {
  override get message() {
    switch (this.reason) {
      case "message-source":
        return "Provide exactly one of --message or --message-file.";
      case "no-devices":
        return "No active devices are subscribed to background push on this environment.";
      case "delivery":
        return "Some push services rejected the notification. See the delivery counts above.";
    }
  }
}

const decodeNotification = Schema.decodeUnknownEffect(NotificationSendInput);

export const notifyCommand = Command.make("notify", {
  ...projectLocationFlags,
  title: Flag.String("title"),
  message: Flag.String("message").pipe(Flag.optional),
  messageFile: Flag.String("message-file").pipe(Flag.optional),
  url: Flag.String("url").pipe(Flag.optional),
  tag: Flag.String("tag").pipe(Flag.optional),
  idempotencyKey: Flag.String("idempotency-key").pipe(Flag.optional),
}).pipe(
  Command.withDescription("Send a push notification to devices subscribed to this environment."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (Option.isSome(flags.message) === Option.isSome(flags.messageFile))
        return yield* new NotifyCliError({ reason: "message-source" });
      const fs = yield* FileSystem.FileSystem;
      const body = Option.isSome(flags.messageFile)
        ? yield* fs.readFileString(flags.messageFile.value)
        : Option.getOrElse(flags.message, () => "");
      const input = yield* decodeNotification({
        title: flags.title,
        body,
        ...(Option.isSome(flags.url) ? { url: flags.url.value } : {}),
        ...(Option.isSome(flags.tag) ? { tag: flags.tag.value } : {}),
        ...(Option.isSome(flags.idempotencyKey)
          ? { idempotencyKey: flags.idempotencyKey.value }
          : {}),
      });
      return yield* withLocalEnvironment(flags, ({ origin, token }) =>
        Effect.gen(function* () {
          const client = yield* makeEnvironmentHttpClient(origin);
          const result = yield* client.notifications.send({
            headers: { authorization: `Bearer ${token}` },
            payload: input,
          });
          yield* Console.log(yield* encodeCliJson(result));
          if (result.failed > 0) return yield* new NotifyCliError({ reason: "delivery" });
          if (result.sent === 0 && result.skipped === 0)
            return yield* new NotifyCliError({ reason: "no-devices" });
        }),
      );
    }),
  ),
);
