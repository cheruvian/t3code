import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";

import {
  DrainableWorkerClosedError,
  makeDrainableWorker,
  makeKeyedDrainableWorker,
} from "./DrainableWorker.ts";

const captureErrorLogs = () => {
  const loggedErrors: Array<unknown> = [];
  const logger = Logger.make(({ logLevel, cause }) => {
    if (logLevel === "Error") loggedErrors.push(Cause.squash(cause));
  });
  return { loggedErrors, loggerLayer: Logger.layer([logger], { mergeWithExisting: false }) };
};

describe("makeDrainableWorker", () => {
  it.effect("logs a failed or defective item and keeps processing later items", () => {
    const { loggedErrors, loggerLayer } = captureErrorLogs();

    return Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const workerFiber = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
        const worker = yield* makeDrainableWorker((item: string) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(workerFiber, yield* Effect.fiber);
            if (item === "fail") return yield* Effect.fail("typed failure");
            if (item === "die") return yield* Effect.die("defect");
            if (item === "interrupt") return yield* Effect.interrupt;
            processed.push(item);
          }),
        );

        yield* worker.enqueue("fail");
        yield* worker.enqueue("die");
        yield* worker.enqueue("interrupt");
        yield* worker.enqueue("ok");

        // A stopped worker never drains; its exit settles the race instead of a hang.
        yield* Effect.raceFirst(worker.drain, Fiber.await(yield* Deferred.await(workerFiber)));

        expect(processed).toEqual(["ok"]);
        // The item that interrupted itself was cancelled, not failed.
        expect(loggedErrors).toEqual(["typed failure", "defect"]);
      }),
    ).pipe(Effect.provide(loggerLayer));
  });

  it.effect("stops quietly when its scope closes during an item", () => {
    const { loggedErrors, loggerLayer } = captureErrorLogs();

    return Effect.gen(function* () {
      const scope = yield* Scope.make();
      const processed: string[] = [];
      const workerFiber = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
      const worker = yield* makeDrainableWorker((item: string) =>
        Effect.gen(function* () {
          processed.push(item);
          yield* Deferred.succeed(workerFiber, yield* Effect.fiber);
          return yield* Effect.never;
        }),
      ).pipe(Scope.provide(scope));

      yield* worker.enqueue("block");
      yield* worker.enqueue("later");
      const fiber = yield* Deferred.await(workerFiber);
      yield* Scope.close(scope, Exit.void);

      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
      expect(processed).toEqual(["block"]);
      expect(loggedErrors).toEqual([]);

      // Queued and late items are dropped with the queue, so drain resolves at once.
      yield* worker.enqueue("after close");
      const drained = yield* Effect.forkChild(worker.drain, { startImmediately: true });
      expect(drained.pollUnsafe()).toEqual(Exit.void);
      expect(processed).toEqual(["block"]);
    }).pipe(Effect.provide(loggerLayer));
  });

  it.live("waits for work enqueued during active processing before draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const worker = yield* makeDrainableWorker((item: string) =>
          Effect.gen(function* () {
            if (item === "first") {
              yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseFirst);
            }

            if (item === "second") {
              yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseSecond);
            }

            processed.push(item);
          }),
        );

        yield* worker.enqueue("first");
        yield* Deferred.await(firstStarted);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );

        yield* worker.enqueue("second");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);

        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["first", "second"]);
      }),
    ),
  );
});

describe("makeKeyedDrainableWorker", () => {
  it.live("uses available capacity without overlapping work for the same key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const a1Started = yield* Deferred.make<void>();
        const releaseA1 = yield* Deferred.make<void>();
        const a2Started = yield* Deferred.make<void>();
        const b1Started = yield* Deferred.make<void>();

        const worker = yield* makeKeyedDrainableWorker({
          concurrency: 2,
          key: (item: { readonly key: string; readonly id: string }) => item.key,
          process: (item) =>
            Effect.gen(function* () {
              if (item.id === "A1") {
                yield* Deferred.succeed(a1Started, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseA1);
              }

              if (item.id === "A2") {
                yield* Deferred.succeed(a2Started, undefined).pipe(Effect.orDie);
              }

              if (item.id === "B1") {
                yield* Deferred.succeed(b1Started, undefined).pipe(Effect.orDie);
              }
            }),
        });

        yield* worker.enqueue({ key: "A", id: "A1" });
        yield* Deferred.await(a1Started);
        yield* worker.enqueue({ key: "A", id: "A2" });
        yield* worker.enqueue({ key: "B", id: "B1" });

        yield* Deferred.await(b1Started);
        expect(yield* Deferred.isDone(a2Started)).toBe(false);

        yield* Deferred.succeed(releaseA1, undefined);
        yield* Deferred.await(a2Started);
      }),
    ),
  );

  it.live("drains only work admitted before its snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();
        const drained = yield* Deferred.make<void>();
        const worker = yield* makeKeyedDrainableWorker({
          concurrency: 1,
          key: (item: { readonly id: string }) => item.id,
          process: (item) =>
            Effect.gen(function* () {
              if (item.id === "first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirst);
              } else {
                yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseSecond);
              }
            }),
        });

        yield* worker.enqueue({ id: "first" });
        yield* Deferred.await(firstStarted);
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );
        yield* Effect.yieldNow;
        yield* worker.enqueue({ id: "second" });
        yield* Deferred.succeed(releaseFirst, undefined);

        yield* Deferred.await(drained);
        yield* Deferred.await(secondStarted);
        expect(yield* Deferred.isDone(releaseSecond)).toBe(false);
        yield* Deferred.succeed(releaseSecond, undefined);
      }),
    ),
  );

  it.live("schedules ready keys fairly", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const order: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const worker = yield* makeKeyedDrainableWorker({
          concurrency: 1,
          key: (item: { readonly key: string; readonly id: string }) => item.key,
          process: (item) =>
            Effect.gen(function* () {
              order.push(item.id);
              if (item.id === "A1") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirst);
              }
            }),
        });

        yield* worker.enqueue({ key: "A", id: "A1" });
        yield* Deferred.await(firstStarted);
        yield* worker.enqueue({ key: "A", id: "A2" });
        yield* worker.enqueue({ key: "A", id: "A3" });
        yield* worker.enqueue({ key: "B", id: "B1" });
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* worker.drain;

        expect(order).toEqual(["A1", "B1", "A2", "A3"]);
      }),
    ),
  );

  it.live("retires failed work and continues the key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const worker = yield* makeKeyedDrainableWorker({
          concurrency: 1,
          key: (_item: string) => "same-key",
          process: (item) =>
            Effect.sync(() => processed.push(item)).pipe(
              Effect.andThen(item === "first" ? Effect.fail("boom") : Effect.void),
            ),
        });

        yield* worker.enqueue("first");
        yield* worker.enqueue("second");
        yield* worker.drain;

        expect(processed).toEqual(["first", "second"]);
      }),
    ),
  );

  it.live("shares one closing drain across concurrent shutdown callers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const firstShutdownComplete = yield* Deferred.make<void>();
        const secondShutdownStarted = yield* Deferred.make<void>();
        const secondShutdownComplete = yield* Deferred.make<void>();
        const worker = yield* makeKeyedDrainableWorker({
          concurrency: 1,
          key: (_item: string) => "same-key",
          process: (item) =>
            Effect.gen(function* () {
              processed.push(item);
              if (item === "first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirst);
              }
            }),
        });

        yield* worker.enqueue("first");
        yield* worker.enqueue("second");
        yield* Deferred.await(firstStarted);
        yield* Effect.forkChild(
          worker.shutdown.pipe(
            Effect.tap(() => Deferred.succeed(firstShutdownComplete, undefined).pipe(Effect.orDie)),
          ),
        );
        yield* Effect.yieldNow;

        const rejection = yield* Effect.flip(worker.enqueue("late"));
        expect(rejection).toBeInstanceOf(DrainableWorkerClosedError);
        expect(rejection._tag).toBe("DrainableWorkerClosedError");
        yield* Effect.forkChild(
          Deferred.succeed(secondShutdownStarted, undefined).pipe(
            Effect.orDie,
            Effect.andThen(worker.shutdown),
            Effect.tap(() =>
              Deferred.succeed(secondShutdownComplete, undefined).pipe(Effect.orDie),
            ),
          ),
        );
        yield* Deferred.await(secondShutdownStarted);
        expect(yield* Deferred.isDone(firstShutdownComplete)).toBe(false);
        expect(yield* Deferred.isDone(secondShutdownComplete)).toBe(false);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(firstShutdownComplete);
        yield* Deferred.await(secondShutdownComplete);
        yield* worker.shutdown;
        expect(processed).toEqual(["first", "second"]);
      }),
    ),
  );
});
