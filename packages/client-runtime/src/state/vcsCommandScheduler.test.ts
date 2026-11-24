import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, AtomRegistry } from "effect/reactivity";

import {
  vcsCommandConcurrency,
  vcsCommandScheduler,
  vcsRefreshCommandScheduler,
} from "./vcsCommandScheduler.ts";

describe("Git refresh scheduling", () => {
  it("coalesces refreshes while preserving the order of Git mutations", async () => {
    const registry = AtomRegistry.make();
    const gate = Promise.withResolvers<void>();
    const target = { environmentId: EnvironmentId.make("test"), input: { cwd: "/repo" } };
    const starts: string[] = [];
    let refreshes = 0;
    const refresh = () =>
      Effect.runPromise(
        vcsRefreshCommandScheduler.schedule(
          registry,
          vcsCommandConcurrency,
          target,
          Effect.promise(async () => {
            const number = ++refreshes;
            starts.push(`refresh-${number}`);
            if (number === 1) await gate.promise;
            return AsyncResult.success(number);
          }),
        ),
      );
    try {
      const first = refresh();
      const pull = Effect.runPromise(
        vcsCommandScheduler.schedule(
          registry,
          vcsCommandConcurrency,
          target,
          Effect.sync(() => {
            starts.push("pull");
            return AsyncResult.success(undefined);
          }),
        ),
      );
      const pending = Array.from({ length: 19 }, refresh);
      expect(starts).toEqual(["refresh-1"]);
      gate.resolve();
      await first;
      await pull;
      const results = await Promise.all(pending);
      expect(starts).toEqual(["refresh-1", "pull", "refresh-2"]);
      expect(results.every((result) => result._tag === "Success" && result.value === 2)).toBe(true);
    } finally {
      gate.resolve();
      registry.dispose();
    }
  });
});
