import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DesktopSafeShutdown } from "../../app/DesktopSafeShutdown.ts";
import * as Channels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
export const resolve = DesktopIpc.makeIpcMethod({
  channel: Channels.SAFE_SHUTDOWN_RESOLVE_CHANNEL,
  payload: Schema.Struct({
    requestId: Schema.String,
    resolution: Schema.Literals(["committed", "cancelled", "failed"]),
  }),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.safeShutdown.resolve")(function* (input) {
    yield* (yield* DesktopSafeShutdown).resolve(input.requestId, input.resolution);
  }),
});
