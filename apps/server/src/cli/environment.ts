import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type AuthSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

export class CliEnvironmentError extends Schema.TaggedError<CliEnvironmentError>()(
  "CliEnvironmentError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const makeEnvironmentHttpClient = (origin: string) =>
  HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });

export const encodeCliJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** Use only the running environment selected by --base-dir; never start offline state. */
export const withLocalEnvironment = <A, E, R>(
  flags: CliAuthLocationFlags,
  run: (input: {
    readonly origin: string;
    readonly token: string;
    readonly sessionId: AuthSessionId;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const runtime = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtime)) {
      return yield* new CliEnvironmentError({
        detail: "A running T3 Code server is required for this command.",
      });
    }
    const origin = runtime.value.origin;
    return yield* Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      return yield* Effect.acquireUseRelease(
        auth.issueSession({
          scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
          label: "t3 cli",
        }),
        (issued) => run({ origin, token: issued.token, sessionId: issued.sessionId }),
        (issued) => auth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
      );
    }).pipe(
      Effect.provide(
        EnvironmentAuth.runtimeLayer.pipe(
          Layer.provideMerge(FetchHttpClient.layer),
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
        ),
      ),
    );
  });
