import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "./config.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as Sqlite from "./persistence/Sqlite.ts";

vi.mock("./NodeFileWatch.ts", async () => {
  const Effect = await import("effect/Effect");
  const Stream = await import("effect/Stream");
  return { watchFile: () => Effect.succeed(Stream.never) };
});

const layer = ServerSettings.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(Layer.fresh(Sqlite.layerMemory)),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-settings-missed-event-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("reloads externally replaced settings when the native watcher emits no events", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const service = yield* ServerSettings.ServerSettingsService;
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({ responseStreamingMode: "turn", projectSettingsFolded: true }),
      );
      yield* service.start;
      const changes = yield* service.subscribeChanges;
      yield* writeFileStringAtomically({
        filePath: config.settingsPath,
        contents: JSON.stringify({
          responseStreamingMode: "paragraph",
          projectSettingsFolded: true,
        }),
      });
      const received = yield* changes.pipe(Stream.runHead, Effect.timeoutOption("2 seconds"));
      assert.equal(
        Option.getOrUndefined(Option.flatten(received))?.responseStreamingMode,
        "paragraph",
      );
    }),
  ).pipe(TestClock.withLive, Effect.provide(layer)),
);
