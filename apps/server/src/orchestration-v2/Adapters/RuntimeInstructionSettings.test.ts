import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ServerSettings from "../../serverSettings.ts";
import { runtimeInstructionSettings } from "./RuntimeInstructionSettings.ts";

it.effect("reads current global instructions after provider construction", () =>
  Effect.gen(function* () {
    const instructions = yield* runtimeInstructionSettings;
    assert.equal(yield* instructions, "First convention");
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({ globalCustomInstructions: "Updated convention" });
    assert.equal(yield* instructions, "Updated convention");
  }).pipe(
    Effect.provide(ServerSettings.layerTest({ globalCustomInstructions: "First convention" })),
  ),
);
