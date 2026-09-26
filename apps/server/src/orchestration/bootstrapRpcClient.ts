import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  ORCHESTRATION_WS_METHODS,
  WsRpcGroup,
  type AuthSessionId,
  type ClientOrchestrationCommand,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

const makeWsRpcClient = RpcClient.make(WsRpcGroup);
type WsRpcClient = Effect.Success<typeof makeWsRpcClient>;

export const withEnvironmentRpc = <A, E, R>(
  input: {
    readonly origin: string;
    readonly sessionId: AuthSessionId;
  },
  run: (rpc: WsRpcClient) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const ticket = yield* auth.issueWebSocketTicket({ sessionId: input.sessionId });
    const url = new URL(input.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.searchParams.set("wsTicket", ticket.ticket);
    const protocolLayer = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(
        Socket.layerWebSocket(url.toString()).pipe(
          Layer.provide(NodeSocket.layerWebSocketConstructor),
        ),
      ),
      Layer.provide(RpcSerialization.layerJson),
    );
    return yield* Effect.gen(function* () {
      const rpc = yield* makeWsRpcClient;
      return yield* run(rpc);
    }).pipe(Effect.provide(protocolLayer), Effect.scoped);
  });

/** Route bootstrap through the WebSocket dispatcher, which owns checkout and turn ordering. */
export const dispatchBootstrapRpc = Effect.fn("dispatchBootstrapRpc")(function* (input: {
  readonly origin: string;
  readonly sessionId: AuthSessionId;
  readonly command: Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;
  readonly waitForThread?: ThreadId;
}) {
  return yield* withEnvironmentRpc(input, (rpc) =>
    Effect.gen(function* () {
      const dispatch = yield* rpc[ORCHESTRATION_WS_METHODS.dispatchCommand](input.command);
      if (!input.waitForThread) return { dispatch, thread: null };
      const threadId = input.waitForThread;
      const thread = yield* rpc[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
        Stream.filterMap((item) => {
          const matching =
            item.kind === "snapshot"
              ? item.snapshot.threads.find((entry) => entry.id === threadId)
              : item.kind === "thread-upserted" && item.thread.id === threadId
                ? item.thread
                : undefined;
          return matching?.worktreePath ? Result.succeed(matching) : Result.failVoid;
        }),
        Stream.runHead,
        Effect.timeout("30 seconds"),
      );
      return { dispatch, thread: Option.getOrNull(thread) };
    }),
  );
});
