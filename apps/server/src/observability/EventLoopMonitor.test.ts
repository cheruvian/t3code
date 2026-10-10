import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import * as Ref from "effect/Ref";

import * as EventLoopMonitor from "./EventLoopMonitor.ts";

const ms = (value: number) => value * 1e6;

// Node's native timer interval is included in the reported gap.
const stalled: EventLoopMonitor.EventLoopReadings = {
  delayMaxNs: ms(4_970),
  delayP95Ns: ms(35),
  delayP99Ns: ms(120),
  delayMeanNs: ms(25),
  activeMs: 6_200,
  utilization: 0.176,
  usage: {
    userCPUTime: 310_400,
    systemCPUTime: 95_600,
    majorPageFault: 8_412,
    minorPageFault: 20_031,
    involuntaryContextSwitches: 57,
  },
  rssBytes: 1536 * 1024 * 1024,
};
// Over the threshold as read, but not once the resolution is subtracted.
const quiet: EventLoopMonitor.EventLoopReadings = { ...stalled, delayMaxNs: ms(20) };

describe("EventLoopMonitor", () => {
  it.effect("changes reporting cadence at the next timer boundary", () =>
    Effect.gen(function* () {
      const interval = yield* Ref.make(5000);
      let samples = 0;
      yield* Layer.build(
        EventLoopMonitor.layerWith(
          Effect.succeed(
            Effect.sync(() => {
              samples++;
              return quiet;
            }),
          ),
          Ref.get(interval),
        ),
      );
      yield* TestClock.adjust("1 second");
      yield* Ref.set(interval, 10000);
      yield* TestClock.adjust("4 seconds");
      assert.equal(samples, 1);
      yield* TestClock.adjust("9 seconds");
      assert.equal(samples, 1);
      yield* TestClock.adjust("1 second");
      assert.equal(samples, 2);
    }),
  );
  it.effect("records a warning span only for samples that saw a stall", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      // The first sample covers startup, so the monitor discards it.
      const samples = [stalled, quiet, stalled];

      yield* Effect.gen(function* () {
        yield* Layer.build(
          EventLoopMonitor.layerWith(Effect.succeed(Effect.sync(() => samples.shift() ?? quiet))),
        );
        yield* TestClock.adjust("60 seconds");
        assert.lengthOf(spans, 1);
        yield* TestClock.adjust("30 seconds");
      }).pipe(Effect.scoped, Effect.withTracer(tracer));

      assert.deepStrictEqual(
        spans.map((span) => span.name),
        ["server.eventLoop.health", "server.eventLoop.health", "server.eventLoop.stall"],
      );
      const span = spans.at(-1);
      assert.deepStrictEqual(Object.fromEntries(span!.attributes), {
        delayMaxMs: 4_950,
        utilization: 0.18,
        cpuUserMs: 310,
        cpuSystemMs: 96,
        majorPageFaults: 8_412,
        minorPageFaults: 20_031,
        involuntaryContextSwitches: 57,
        rssMb: 1536,
      });
      assert.deepStrictEqual(
        span!.events.map(([name, , attributes]) => [name, attributes["effect.logLevel"]]),
        [["event loop stalled for 4950 ms", "WARN"]],
      );
    }),
  );

  it("ignores delay the loop spent idle, such as a system sleep", () => {
    // Waking from sleep reads as a long gap, but the loop was idle in poll for it.
    const asleep: EventLoopMonitor.EventLoopReadings = {
      ...stalled,
      delayMaxNs: ms(600_000),
      activeMs: 900,
    };
    assert.isUndefined(EventLoopMonitor.stallMs(asleep));
    assert.strictEqual(EventLoopMonitor.stallMs({ ...asleep, activeMs: 600_000 }), 599_980);
  });

  it.effect("records subsecond delay percentiles without a stall warning", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      yield* Effect.gen(function* () {
        yield* Layer.build(
          EventLoopMonitor.layerWith(
            Effect.succeed(
              Effect.succeed({
                ...stalled,
                delayMaxNs: ms(370),
              }),
            ),
          ),
        );
        yield* TestClock.adjust("60 seconds");
      }).pipe(Effect.scoped, Effect.withTracer(tracer));
      assert.deepStrictEqual(
        spans.map((span) => span.name),
        ["server.eventLoop.health"],
      );
      assert.deepStrictEqual(Object.fromEntries(spans[0]!.attributes), {
        delayMaxMs: 350,
        delayP95Ms: 15,
        delayP99Ms: 100,
        delayMeanMs: 5,
        idleGapDetected: false,
        utilization: 0.176,
      });
    }),
  );
});
