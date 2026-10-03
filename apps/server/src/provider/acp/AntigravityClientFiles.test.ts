import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { writeAntigravityClientTextFile } from "./AntigravityClientFiles.ts";

it.effect("writes missing nested directories beneath a canonicalized workspace alias", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-acp-files-" });
    const workspace = path.join(base, "workspace");
    const alias = path.join(base, "alias");
    yield* fileSystem.makeDirectory(workspace);
    yield* fileSystem.symlink(workspace, alias);
    yield* writeAntigravityClientTextFile({
      fileSystem,
      path,
      allowedRoots: [alias],
      request: {
        sessionId: "test",
        path: path.join(alias, "src", "nested", "file.ts"),
        content: "inside",
      },
    });
    assert.equal(
      yield* fileSystem.readFileString(path.join(workspace, "src", "nested", "file.ts")),
      "inside",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects a dangling symlink in any missing file's ancestors", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-acp-files-" });
    const workspace = path.join(base, "workspace");
    const missingTarget = path.join(base, "outside");
    yield* fileSystem.makeDirectory(workspace);
    yield* fileSystem.symlink(missingTarget, path.join(workspace, "broken"));
    const result = yield* writeAntigravityClientTextFile({
      fileSystem,
      path,
      allowedRoots: [workspace],
      request: {
        sessionId: "test",
        path: path.join(workspace, "broken", "nested", "file.ts"),
        content: "outside",
      },
    }).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.isFalse(yield* fileSystem.exists(missingTarget));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects missing nested files reached through an outside symlink", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-acp-files-" });
    const workspace = path.join(base, "workspace");
    const outside = path.join(base, "outside");
    yield* fileSystem.makeDirectory(workspace);
    yield* fileSystem.makeDirectory(outside);
    yield* fileSystem.symlink(outside, path.join(workspace, "escape"));
    const result = yield* writeAntigravityClientTextFile({
      fileSystem,
      path,
      allowedRoots: [workspace],
      request: {
        sessionId: "test",
        path: path.join(workspace, "escape", "nested", "file.ts"),
        content: "outside",
      },
    }).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.isFalse(yield* fileSystem.exists(path.join(outside, "nested")));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
