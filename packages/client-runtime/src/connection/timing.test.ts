import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { ConnectionTransientError } from "./model.ts";
import {
  DEFAULT_CONNECTION_TIMING,
  makeConnectionTiming,
  type ConnectionTimingSettings,
} from "./timing.ts";
import { retryDelayMs } from "./supervisor.ts";

describe("connection timing preferences", () => {
  it.effect("persists changes, reloads them, and resets defaults", () =>
    Effect.gen(function* () {
      const stored = yield* Ref.make<ConnectionTimingSettings | undefined>(undefined);
      const storage = {
        read: Ref.get(stored),
        write: (settings: ConnectionTimingSettings) => Ref.set(stored, settings),
      };
      const timing = yield* makeConnectionTiming(storage);
      expect(yield* timing.get).toEqual(DEFAULT_CONNECTION_TIMING);
      const next = {
        ...DEFAULT_CONNECTION_TIMING,
        setupSeconds: 60,
        requestSeconds: 30,
        resumeProbeSeconds: 15,
        heartbeatSeconds: 60,
        retryMaxSeconds: 15,
      };
      yield* timing.set(next);
      const reloaded = yield* makeConnectionTiming(storage);
      expect(yield* reloaded.get).toEqual(next);
      expect(
        retryDelayMs(12, 0.99, (yield* reloaded.get).retryMaxSeconds * 1000),
      ).toBeLessThanOrEqual(15000);
      yield* reloaded.set(DEFAULT_CONNECTION_TIMING);
      expect(yield* Ref.get(stored)).toEqual(DEFAULT_CONNECTION_TIMING);
    }),
  );
  it.effect("preserves current settings if persistence fails or input is invalid", () =>
    Effect.gen(function* () {
      const timing = yield* makeConnectionTiming({
        read: Effect.succeed(undefined),
        write: () =>
          Effect.fail(
            new ConnectionTransientError({ reason: "transport", detail: "Storage unavailable" }),
          ),
      });
      const failure = yield* timing
        .set({ ...DEFAULT_CONNECTION_TIMING, setupSeconds: 60 })
        .pipe(Effect.flip);
      expect(failure.message).toBe("Storage unavailable");
      expect(yield* timing.get).toEqual(DEFAULT_CONNECTION_TIMING);
      const invalid = yield* timing
        .set({ ...DEFAULT_CONNECTION_TIMING, setupSeconds: 0 })
        .pipe(Effect.flip);
      expect(invalid.reason).toBe("configuration");
      expect(yield* timing.get).toEqual(DEFAULT_CONNECTION_TIMING);
    }),
  );
});
