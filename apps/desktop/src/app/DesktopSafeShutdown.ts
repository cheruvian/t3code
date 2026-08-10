import { randomUUID } from "node:crypto";

import type { DesktopSafeShutdownAction, DesktopSafeShutdownResolution } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { SAFE_SHUTDOWN_REQUEST_CHANNEL } from "../ipc/channels.ts";

export class DesktopSafeShutdown extends Context.Service<
  DesktopSafeShutdown,
  {
    readonly request: (
      action: DesktopSafeShutdownAction,
    ) => Effect.Effect<DesktopSafeShutdownResolution>;
    readonly resolve: (
      requestId: string,
      resolution: DesktopSafeShutdownResolution,
    ) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopSafeShutdown") {}

export const make = Effect.gen(function* () {
  const windows = yield* ElectronWindow.ElectronWindow;
  const pending = yield* Ref.make(
    new Map<string, Deferred.Deferred<DesktopSafeShutdownResolution>>(),
  );
  const requestLease = yield* Semaphore.make(1);

  const resolve = (requestId: string, resolution: DesktopSafeShutdownResolution) =>
    Ref.modify(pending, (requests) => {
      const deferred = requests.get(requestId);
      if (deferred === undefined) return [Effect.void, requests] as const;
      const next = new Map(requests);
      next.delete(requestId);
      return [Deferred.succeed(deferred, resolution).pipe(Effect.asVoid), next] as const;
    }).pipe(Effect.flatten);

  const request = (action: DesktopSafeShutdownAction) =>
    requestLease.withPermits(1)(
      Effect.gen(function* () {
        const target = yield* windows.currentMainOrFirst;
        if (Option.isNone(target) || target.value.isDestroyed()) return "failed" as const;
        const requestId = randomUUID();
        const deferred = yield* Deferred.make<DesktopSafeShutdownResolution>();
        yield* Ref.update(pending, (requests) => new Map(requests).set(requestId, deferred));
        target.value.webContents.send(SAFE_SHUTDOWN_REQUEST_CHANNEL, { requestId, action });
        yield* windows.reveal(target.value);
        return yield* Deferred.await(deferred);
      }),
    );

  yield* Effect.addFinalizer(() =>
    Ref.getAndSet(pending, new Map()).pipe(
      Effect.flatMap((requests) =>
        Effect.forEach(requests.values(), (deferred) => Deferred.succeed(deferred, "failed"), {
          discard: true,
        }),
      ),
    ),
  );

  return DesktopSafeShutdown.of({ request, resolve });
});

export const layer = Layer.effect(DesktopSafeShutdown, make);
