import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import type { OrchestrationV2ServerCommand } from "@t3tools/contracts";

export const requiresDrainAdmission = (command: OrchestrationV2ServerCommand) =>
  command.type === "message.dispatch" ||
  command.type === "queued-run.start" ||
  command.type === "queue.resume" ||
  command.type === "thread.fork" ||
  command.type === "thread.runtime-mode.set" ||
  command.type === "thread.interaction-mode.set" ||
  command.type === "thread.model-selection.set";

export class ServerDrainAdmission extends Context.Service<
  ServerDrainAdmission,
  {
    readonly enter: () => boolean;
    readonly leave: () => void;
    readonly isClosed: () => boolean;
    readonly close: Effect.Effect<void>;
    readonly open: Effect.Effect<void>;
  }
>()("t3/serverDrainAdmission") {}

export const layer = Layer.effect(
  ServerDrainAdmission,
  Effect.sync(() => {
    let closed = false;
    let active = 0;
    let idle = Deferred.makeUnsafe<void>();
    return ServerDrainAdmission.of({
      enter: () => {
        if (closed) return false;
        if (active === 0) idle = Deferred.makeUnsafe<void>();
        active++;
        return true;
      },
      leave: () => {
        active--;
        if (active === 0) Deferred.doneUnsafe(idle, Effect.void);
      },
      isClosed: () => closed,
      close: Effect.gen(function* () {
        closed = true;
        if (active > 0) yield* Deferred.await(idle);
      }),
      open: Effect.gen(function* () {
        idle = yield* Deferred.make<void>();
        closed = false;
      }),
    });
  }),
);
