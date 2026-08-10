import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import * as DrainableWorker from "./DrainableWorker.ts";

type MakeKeyedDrainableWorker = <A, K, E, R>(options: {
  readonly concurrency: number;
  readonly key: (item: A) => K;
  readonly process: (item: A) => Effect.Effect<void, E, R>;
}) => Effect.Effect<
  {
    readonly enqueue: (item: A) => Effect.Effect<void>;
  },
  never,
  Scope.Scope | R
>;

describe("makeDrainableWorker", () => {
  it.live("waits for work enqueued during active processing before draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const worker = yield* DrainableWorker.makeDrainableWorker((item: string) =>
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
        const candidate: unknown = Reflect.get(DrainableWorker, "makeKeyedDrainableWorker");

        expect(candidate).toBeTypeOf("function");
        if (typeof candidate !== "function") return;

        const makeKeyedDrainableWorker = candidate as MakeKeyedDrainableWorker;
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
});
