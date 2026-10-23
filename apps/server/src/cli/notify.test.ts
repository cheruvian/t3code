import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Command } from "effect/cli";

import { notifyCommand } from "./notify.ts";

const run = (args: readonly string[]) =>
  Command.runWith(notifyCommand, { version: "0.0.0" })(args).pipe(
    Effect.provide(Layer.merge(NodeServices.layer, NetService.layer)),
  );

describe("notify CLI validation", () => {
  it.effect.each([
    ["--title", "Job"],
    ["--title", "Job", "--message", "Done", "--message-file", "/file-that-should-not-be-read"],
  ])("requires exactly one message source before contacting an environment", (args) =>
    Effect.gen(function* () {
      const error = yield* run(args).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "NotifyCliError", reason: "message-source" });
    }),
  );
  it.effect("rejects unsafe links before contacting an environment", () =>
    Effect.gen(function* () {
      const error = yield* run([
        "--title",
        "Job",
        "--message",
        "Done",
        "--url",
        "javascript:alert(1)",
      ]).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "SchemaError" });
    }),
  );
});
