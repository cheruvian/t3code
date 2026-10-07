import * as Effect from "effect/Effect";

import { environmentEndpointUrl } from "./endpoint.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiGroupClient } from "../rpc/http.ts";

import { ConnectionTiming } from "../connection/timing.ts";

export const fetchRemoteEnvironmentDescriptor = Effect.fn(
  "clientRuntime.environment.fetchRemoteEnvironmentDescriptor",
)(function* (input: { readonly httpBaseUrl: string; readonly timeoutMs?: number }) {
  const client = yield* makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "metadata");
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/.well-known/t3/environment"),
    input.timeoutMs ?? (yield* (yield* ConnectionTiming).get).requestSeconds * 1_000,
    client.descriptor(),
  );
});
