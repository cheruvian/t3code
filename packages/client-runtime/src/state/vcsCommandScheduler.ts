import type { EnvironmentId } from "@t3tools/contracts";

import {
  createAtomCommandScheduler,
  type AtomCommandConcurrency,
  type AtomCommandScheduler,
} from "./runtime.ts";

export const vcsCommandScheduler = createAtomCommandScheduler();

export const vcsCommandConcurrency: AtomCommandConcurrency<{
  readonly environmentId: EnvironmentId;
  readonly input: { readonly cwd: string };
}> = {
  mode: "serial",
  key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd]),
};

const refreshCommands = createAtomCommandScheduler();

// Collapse refresh demand before entering the shared FIFO used by Git mutations.
export const vcsRefreshCommandScheduler: AtomCommandScheduler = {
  schedule: (registry, concurrency, input, execute) =>
    concurrency.mode === "parallel"
      ? vcsCommandScheduler.schedule(registry, concurrency, input, execute)
      : refreshCommands.schedule(registry, { mode: "latest", key: concurrency.key }, input, () =>
          vcsCommandScheduler.schedule(registry, concurrency, input, execute),
        ),
};
