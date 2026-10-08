import { DEFAULT_PERFORMANCE_SETTINGS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ServerSettings from "./serverSettings.ts";

/** Capture the environment service once; each new timer window reads its current settings. */
export const runtimePerformanceSettings = Effect.map(
  ServerSettings.ServerSettingsService,
  (service) =>
    service.getSettings.pipe(
      Effect.map((settings) => settings.performance),
      Effect.orElseSucceed(() => DEFAULT_PERFORMANCE_SETTINGS),
    ),
);
