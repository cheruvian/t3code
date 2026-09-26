import { ServerSettingsPatch, WS_METHODS } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import { withEnvironmentRpc } from "../orchestration/bootstrapRpcClient.ts";
import { projectLocationFlags } from "./config.ts";
import { encodeCliJson, withLocalEnvironment } from "./environment.ts";

const decodeSettingsPatch = Schema.decodeEffect(Schema.fromJsonString(ServerSettingsPatch));

const getSettings = Command.make("get", { ...projectLocationFlags }).pipe(
  Command.withHandler((flags) =>
    withLocalEnvironment(flags, ({ origin, sessionId }) =>
      withEnvironmentRpc({ origin, sessionId }, (rpc) =>
        Effect.gen(function* () {
          const settings = yield* rpc[WS_METHODS.serverGetSettings]({});
          yield* Console.log(yield* encodeCliJson(settings));
        }),
      ),
    ),
  ),
);

const patchSettings = Command.make("patch", {
  ...projectLocationFlags,
  file: Flag.String("file"),
}).pipe(
  Command.withHandler((flags) =>
    withLocalEnvironment(flags, ({ origin, sessionId }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const patch = yield* decodeSettingsPatch(yield* fs.readFileString(flags.file));
        const settings = yield* withEnvironmentRpc({ origin, sessionId }, (rpc) =>
          rpc[WS_METHODS.serverUpdateSettings]({ patch }),
        );
        yield* Console.log(yield* encodeCliJson(settings));
      }),
    ),
  ),
);

export const settingsCommand = Command.make("settings").pipe(
  Command.withDescription("Read or patch server settings."),
  Command.withSubcommands([getSettings, patchSettings]),
);
