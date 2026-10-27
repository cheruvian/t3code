import * as NetService from "@t3tools/shared/Net";
import * as Layer from "effect/Layer";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";

const calls = vi.hoisted(() => [] as Array<{ operation: string; flags: Record<string, unknown> }>);
vi.mock("./threadOperations.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./threadOperations.ts")>();
  const effect = await import("effect/Effect");
  const handler = (operation: string) => (flags: Record<string, unknown>) =>
    effect.sync(() => {
      calls.push({ operation, flags });
    });
  return {
    ...original,
    runIsolatedThreadStart: handler("start"),
    runThreadMessageFile: handler("send"),
    runThreadList: handler("list"),
  };
});
import { threadCommand } from "./thread.ts";

it.effect("dispatches the documented isolated message-file launch with provider aliases", () =>
  Effect.gen(function* () {
    calls.length = 0;
    yield* Command.runWith(threadCommand, { version: "0.0.0" })([
      "start",
      "project-1",
      "--title",
      "Fix billing",
      "--message-file",
      "/tmp/prompt.md",
      "--base-branch",
      "main",
      "--instance",
      "codex",
      "--model",
      "gpt-6-sol",
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.operation, "start");
    assert.equal(calls[0]!.flags.baseBranch, "main");
    assert.equal(calls[0]!.flags.messageFile, "/tmp/prompt.md");
    assert.deepEqual(calls[0]!.flags.instance, Option.some("codex"));
  }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NetService.layer))),
);

it.effect("dispatches message-file sends and unscoped thread lists", () =>
  Effect.gen(function* () {
    calls.length = 0;
    const run = Command.runWith(threadCommand, { version: "0.0.0" });
    yield* run(["send", "thread-1", "--message-file", "/tmp/prompt.md"]);
    yield* run(["list", "--limit", "12"]);
    assert.deepEqual(
      calls.map(({ operation }) => operation),
      ["send", "list"],
    );
    assert.equal(calls[0]!.flags.threadId, "thread-1");
    assert.deepEqual(calls[1]!.flags.limit, Option.some(12));
  }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NetService.layer))),
);
