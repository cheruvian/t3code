// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

import { validateClaudeNativeSession } from "./ClaudeNativeSessionLoader.ts";
import { encodeClaudeProjectPath } from "./NativeSessionTransfer.ts";

const temporaryDirectories: Array<string> = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

it.effect(
  "loads a real Claude SDK fixture by canonical cwd and rejects corrupt or missing data",
  () =>
    Effect.gen(function* () {
      const { input, transcriptPath, nativeThreadId, userMessageId } = yield* Effect.promise(
        async () => {
          const homePath = await temporaryDirectory("t3-claude-loader-home-");
          const logicalCwd = await temporaryDirectory("t3-claude-loader-cwd.with_punctuation-");
          const canonicalCwd = await NodeFSP.realpath(logicalCwd);
          const nativeThreadId = "019fbbc1-b12c-7360-a685-28c181f0025f";
          const userMessageId = "11111111-1111-4111-8111-111111111111";
          const assistantMessageId = "22222222-2222-4222-8222-222222222222";
          const projectDirectory = NodePath.join(
            homePath,
            "projects",
            encodeClaudeProjectPath(canonicalCwd),
          );
          const transcriptPath = NodePath.join(projectDirectory, `${nativeThreadId}.jsonl`);
          await NodeFSP.mkdir(projectDirectory, { recursive: true });
          await NodeFSP.writeFile(
            transcriptPath,
            [
              encodeRecord({
                type: "user",
                uuid: userMessageId,
                parentUuid: null,
                sessionId: nativeThreadId,
                cwd: canonicalCwd,
                timestamp: "2026-10-05T12:00:00.000Z",
                message: { role: "user", content: "hello" },
              }),
              encodeRecord({
                type: "assistant",
                uuid: assistantMessageId,
                parentUuid: userMessageId,
                sessionId: nativeThreadId,
                cwd: canonicalCwd,
                timestamp: "2026-10-05T12:00:01.000Z",
                message: {
                  id: "msg_01",
                  type: "message",
                  role: "assistant",
                  model: "claude-sonnet-4-5",
                  content: [{ type: "text", text: "hi" }],
                  stop_reason: "end_turn",
                  stop_sequence: null,
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              }),
            ].join("\n"),
          );
          const input = {
            nativeThreadId,
            cwd: logicalCwd,
            environment: { ...process.env, CLAUDE_CONFIG_DIR: homePath },
            entryPath: NodePath.resolve("apps/server/src/bin.ts"),
          };

          return { input, transcriptPath, nativeThreadId, userMessageId };
        },
      );
      const loaded = yield* validateClaudeNativeSession(input);
      assert.equal(loaded.sessionId, nativeThreadId);
      assert.equal(loaded.firstMessageId, userMessageId);

      yield* Effect.promise(() => NodeFSP.writeFile(transcriptPath, "{invalid-json"));
      const corrupt = yield* Effect.flip(validateClaudeNativeSession(input));
      assert.match(corrupt.message, /could not be loaded/);
      yield* Effect.promise(() => NodeFSP.rm(transcriptPath));
      const missing = yield* Effect.flip(validateClaudeNativeSession(input));
      assert.match(missing.message, /could not be loaded/);
    }),
);
