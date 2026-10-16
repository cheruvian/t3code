import * as Effect from "effect/Effect";
import type * as ProviderHost from "./ProviderHost.ts";

export const globalInstructions = (host: ProviderHost.ProviderHost["Service"]) =>
  host.settings.get.pipe(
    Effect.map((settings) => settings.globalCustomInstructions),
    Effect.catch((cause) =>
      Effect.logWarning("Could not read global provider instructions", cause).pipe(Effect.as("")),
    ),
  );
