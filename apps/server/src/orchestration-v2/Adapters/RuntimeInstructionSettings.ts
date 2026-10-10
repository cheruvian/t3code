import * as Effect from "effect/Effect";
import { ServerSettingsService } from "../../serverSettings.ts";

/** Capture the settings service while constructing a provider; read its current value per turn. */
export const runtimeInstructionSettings = Effect.map(ServerSettingsService, (settings) =>
  settings.getSettings.pipe(
    Effect.map((value) => value.globalCustomInstructions),
    Effect.catch((cause) =>
      Effect.logWarning("Could not read global provider instructions", cause).pipe(Effect.as("")),
    ),
  ),
);
