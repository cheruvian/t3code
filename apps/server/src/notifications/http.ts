import { AuthOrchestrationOperateScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  requireEnvironmentScope,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
} from "../auth/http.ts";
import * as WebPush from "./WebPush.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "notifications",
  Effect.fnUntraced(function* (handlers) {
    const push = yield* WebPush.WebPush;
    return handlers.handle(
      "send",
      Effect.fn("environment.notifications.send")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
        return yield* push.send(args.payload).pipe(
          Effect.catch(
            Effect.fnUntraced(function* (error) {
              if (error.reason === "invalid-message")
                return yield* failEnvironmentInvalidRequest("invalid_command");
              return yield* failEnvironmentInternal("notification_send_failed", error);
            }),
          ),
        );
      }),
    );
  }),
);
