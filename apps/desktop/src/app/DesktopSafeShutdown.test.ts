import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as Electron from "electron";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { DesktopSafeShutdown, layer } from "./DesktopSafeShutdown.ts";

it.effect("waits for the renderer's durable drain resolution", () =>
  Effect.gen(function* () {
    let resolveSent!: (request: { readonly requestId: string; readonly action: string }) => void;
    const sent = new Promise<{ readonly requestId: string; readonly action: string }>((resolve) => {
      resolveSent = resolve;
    });
    const window = {
      isDestroyed: () => false,
      webContents: {
        send: (
          _channel: string,
          request: { readonly requestId: string; readonly action: string },
        ) => {
          resolveSent(request);
        },
      },
    } as unknown as Electron.BrowserWindow;
    const electronWindowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
      currentMainOrFirst: Effect.succeed(Option.some(window)),
      reveal: () => Effect.void,
    } as unknown as ElectronWindow.ElectronWindow["Service"]);

    yield* Effect.scoped(
      Effect.gen(function* () {
        const safeShutdown = yield* DesktopSafeShutdown;
        const request = yield* safeShutdown.request("restart").pipe(Effect.forkChild);
        const envelope = yield* Effect.promise(() => sent);
        assert.equal(envelope.action, "restart");
        yield* safeShutdown.resolve(envelope.requestId, "committed");
        assert.equal(yield* Fiber.join(request), "committed");
      }),
    ).pipe(Effect.provide(layer.pipe(Layer.provide(electronWindowLayer))));
  }),
);
