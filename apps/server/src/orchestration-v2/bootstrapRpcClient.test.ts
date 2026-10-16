import { expect, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { AuthSessionId, TerminalClearInput, WS_METHODS } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NetAddress from "effect/net/NetAddress";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { hasCompatibleOrchestrationProtocol } from "../ws.ts";
import { withEnvironmentRpc } from "./bootstrapRpcClient.ts";

it.effect(
  "connects bootstrap RPCs to a server enforcing protocol negotiation without losing its ticket",
  () =>
    Effect.gen(function* () {
      const calls: Array<typeof TerminalClearInput.Type> = [];
      const group = RpcGroup.make(
        Rpc.make(WS_METHODS.terminalClear, { payload: TerminalClearInput }),
      );
      const handlers = group.toLayer({
        [WS_METHODS.terminalClear]: (input) =>
          Effect.sync(() => {
            calls.push(input);
          }),
      });
      const routes = HttpRouter.add(
        "GET",
        "/ws",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = HttpServerRequest.toURL(request);
          if (Option.isNone(url) || !hasCompatibleOrchestrationProtocol(url.value))
            return HttpServerResponse.empty({ status: 426 });
          if (url.value.searchParams.get("wsTicket") !== "bootstrap-test-ticket")
            return HttpServerResponse.empty({ status: 401 });
          const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
          yield* RpcServer.make(group).pipe(
            Effect.provideService(RpcServer.Protocol, protocol),
            Effect.provide(handlers),
            Effect.forkScoped,
          );
          return yield* httpEffect;
        }).pipe(Effect.provide(RpcSerialization.layerJson)),
      );
      const services = yield* Layer.build(
        HttpRouter.serve(routes, { disableListenLog: true }).pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
        ),
      );
      const origin = NetAddress.formatUrlUnsafe(
        Context.get(services, HttpServer.HttpServer).address,
      );
      const request = { threadId: "thread:bootstrap", terminalId: "term-1" };
      yield* withEnvironmentRpc(
        { origin, sessionId: AuthSessionId.make("bootstrap-session") },
        (rpc) => rpc[WS_METHODS.terminalClear](request),
      ).pipe(
        Effect.provide(
          Layer.mock(EnvironmentAuth.EnvironmentAuth)({
            issueWebSocketTicket: () =>
              Effect.succeed({
                ticket: "bootstrap-test-ticket",
                expiresAt: DateTime.makeUnsafe("2026-10-15T18:00:00.000Z"),
              }),
          }),
        ),
      );
      expect(calls).toEqual([request]);
    }).pipe(Effect.scoped),
);
