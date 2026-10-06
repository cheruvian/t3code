// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const ValidationResult = Schema.Struct({
  sessionId: Schema.String,
  firstMessageId: Schema.String,
});
const decodeValidationResult = Schema.decodeUnknownSync(Schema.fromJsonString(ValidationResult));
const encodeOptions = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ dir: Schema.String })),
);

function workerCommand(input: { readonly execPath?: string; readonly entryPath?: string }): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
} {
  const command = input.execPath ?? process.execPath;
  const entryPath = input.entryPath ?? process.argv[1];
  if (!entryPath || NodePath.resolve(entryPath) === NodePath.resolve(command)) {
    return { command, args: ["__claude-history"] };
  }
  const extension = NodePath.extname(entryPath);
  const workerName = extension === ".ts" ? "claude-history-worker.ts" : "claude-history-worker.mjs";
  return { command, args: [NodePath.join(NodePath.dirname(entryPath), workerName)] };
}

export class ClaudeNativeSessionLoadError extends Schema.TaggedError<ClaudeNativeSessionLoadError>()(
  "ClaudeNativeSessionLoadError",
  {
    nativeThreadId: Schema.String,
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Claude session '${this.nativeThreadId}' could not be loaded for '${this.cwd}'.`;
  }
}

export interface ValidateClaudeNativeSessionInput {
  readonly nativeThreadId: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly entryPath?: string;
}

export const validateClaudeNativeSession = Effect.fn("validateClaudeNativeSession")(function* (
  input: ValidateClaudeNativeSessionInput,
) {
  const canonicalCwd = yield* Effect.tryPromise({
    try: () => NodeFSP.realpath(input.cwd),
    catch: (cause) =>
      new ClaudeNativeSessionLoadError({
        nativeThreadId: input.nativeThreadId,
        cwd: input.cwd,
        cause,
      }),
  });
  const worker = workerCommand(input);
  const result = yield* Effect.tryPromise({
    try: () =>
      execFile(
        worker.command,
        [
          ...worker.args,
          "validateSession",
          input.nativeThreadId,
          encodeOptions({ dir: canonicalCwd }),
        ],
        {
          env: input.environment,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          timeout: 30_000,
        },
      ),
    catch: (cause) =>
      new ClaudeNativeSessionLoadError({
        nativeThreadId: input.nativeThreadId,
        cwd: canonicalCwd,
        cause,
      }),
  });
  const decoded = yield* Effect.try({
    try: () => decodeValidationResult(result.stdout),
    catch: (cause) =>
      new ClaudeNativeSessionLoadError({
        nativeThreadId: input.nativeThreadId,
        cwd: canonicalCwd,
        cause,
      }),
  });
  if (decoded.sessionId !== input.nativeThreadId) {
    return yield* new ClaudeNativeSessionLoadError({
      nativeThreadId: input.nativeThreadId,
      cwd: canonicalCwd,
      cause: "The loader returned a different native session id.",
    });
  }
  return decoded;
});
