import { it, assert } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Admission from "./serverDrainAdmission.ts";

it.effect(
  "closes admission before waiting for every already admitted command, and reopens on cancellation",
  () =>
    Effect.gen(function* () {
      const gate = yield* Admission.ServerDrainAdmission;
      assert.isTrue(gate.enter());
      gate.leave();
      assert.isTrue(gate.enter());
      const closed = yield* Deferred.make<void>();
      const closing = yield* gate.close.pipe(
        Effect.andThen(Deferred.succeed(closed, undefined)),
        Effect.forkChild({ startImmediately: true }),
      );
      assert.isTrue(gate.isClosed());
      assert.isFalse(gate.enter());
      assert.isFalse(yield* Deferred.isDone(closed));
      gate.leave();
      yield* Fiber.join(closing);
      yield* gate.open;
      assert.isTrue(gate.enter());
      gate.leave();
    }).pipe(Effect.provide(Admission.layer)),
);
