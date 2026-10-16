import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { makeCodexTurnUsageCoalescer } from "./CodexTurnUsageCoalescer.ts";

it.effect("keeps only the latest usage in a fixed window without postponing it", () =>
  Effect.gen(function* () {
    const emitted: number[] = [];
    const coalescer = yield* makeCodexTurnUsageCoalescer<number>({
      emit: (value) =>
        Effect.sync(() => {
          emitted.push(value);
        }),
    });
    yield* coalescer.offer("child", 1);
    yield* TestClock.adjust("100 millis");
    yield* coalescer.offer("child", 2);
    assert.deepEqual(emitted, []);
    yield* TestClock.adjust("150 millis");
    assert.deepEqual(emitted, [2]);
    yield* coalescer.offer("child", 3);
    yield* TestClock.adjust("250 millis");
    assert.deepEqual(emitted, [2, 3]);
  }).pipe(Effect.scoped),
);

it.effect("flushes a terminal child's newest usage once and invalidates its timer", () =>
  Effect.gen(function* () {
    const emitted: number[] = [];
    const coalescer = yield* makeCodexTurnUsageCoalescer<number>({
      emit: (value) =>
        Effect.sync(() => {
          emitted.push(value);
        }),
    });
    yield* coalescer.offer("child", 1);
    yield* coalescer.offer("child", 2);
    yield* coalescer.flush("child");
    assert.deepEqual(emitted, [2]);
    yield* coalescer.flush("child");
    yield* TestClock.adjust("250 millis");
    assert.deepEqual(emitted, [2]);
  }).pipe(Effect.scoped),
);

it.effect("lets another child flush while one child's emission is blocked", () =>
  Effect.gen(function* () {
    const blocked = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const emitted: string[] = [];
    const coalescer = yield* makeCodexTurnUsageCoalescer<string>({
      emit: (value) =>
        (value === "slow"
          ? Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              emitted.push(value);
            }),
          ),
        ),
    });
    yield* coalescer.offer("a", "slow");
    yield* coalescer.offer("b", "fast");
    const slow = yield* coalescer.flush("a").pipe(Effect.forkScoped);
    yield* Deferred.await(blocked);
    yield* coalescer.flush("b");
    assert.deepEqual(emitted, ["fast"]);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(slow);
    assert.deepEqual(emitted, ["fast", "slow"]);
  }).pipe(Effect.scoped),
);

it.effect("serializes a timer emission with terminal flush without duplicates", () =>
  Effect.gen(function* () {
    const blocked = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const emitted: number[] = [];
    const coalescer = yield* makeCodexTurnUsageCoalescer<number>({
      emit: (value) =>
        Deferred.succeed(blocked, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(
            Effect.sync(() => {
              emitted.push(value);
            }),
          ),
        ),
    });
    yield* coalescer.offer("child", 1);
    yield* TestClock.adjust("250 millis");
    yield* Deferred.await(blocked);
    const flush = yield* coalescer.flush("child").pipe(Effect.forkScoped);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(flush);
    yield* TestClock.adjust("250 millis");
    assert.deepEqual(emitted, [1]);
  }).pipe(Effect.scoped),
);

it.effect("discards pending usage on owning scope close and ignores later work", () =>
  Effect.gen(function* () {
    const emitted: number[] = [];
    const scope = yield* Scope.make();
    const coalescer = yield* makeCodexTurnUsageCoalescer<number>({
      emit: (value) =>
        Effect.sync(() => {
          emitted.push(value);
        }),
    }).pipe(Effect.provideService(Scope.Scope, scope));
    yield* coalescer.offer("child", 1);
    yield* Scope.close(scope, Exit.void);
    yield* coalescer.offer("child", 2);
    yield* coalescer.flush("child");
    yield* coalescer.close;
    yield* TestClock.adjust("1 second");
    assert.deepEqual(emitted, []);
  }),
);

it.effect("isolates sessions even when native child IDs match", () =>
  Effect.gen(function* () {
    const emitted: number[] = [];
    const first = yield* makeCodexTurnUsageCoalescer<number>({
      emit: (value) =>
        Effect.sync(() => {
          emitted.push(value);
        }),
    });
    const second = yield* makeCodexTurnUsageCoalescer<number>({
      emit: (value) =>
        Effect.sync(() => {
          emitted.push(value);
        }),
    });
    yield* first.offer("child", 1);
    yield* second.offer("child", 2);
    yield* first.close;
    yield* second.flush("child");
    yield* TestClock.adjust("1 second");
    assert.deepEqual(emitted, [2]);
  }).pipe(Effect.scoped),
);
