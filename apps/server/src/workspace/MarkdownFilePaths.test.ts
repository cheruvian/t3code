import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveMarkdownFilePaths } from "./MarkdownFilePaths.ts";

it.layer(NodeServices.layer)("markdown file paths", (it) => {
  it.effect("resolves aliases, root prefixes, and literal collisions without inventing files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped();
      const cwd = path.join(temp, "worktree");
      yield* fs.makeDirectory(path.join(cwd, "worktree"), { recursive: true });
      yield* fs.writeFileString(path.join(cwd, "image.png"), "image");
      yield* fs.writeFileString(path.join(cwd, "collision.txt"), "root");
      yield* fs.writeFileString(path.join(cwd, "worktree", "collision.txt"), "child");
      const alias = path.join(temp, "alias");
      yield* fs.symlink(cwd, alias);
      const paths = [
        "image.png",
        path.join(alias, "image.png"),
        "worktree/image.png",
        "worktree/collision.txt",
        "./worktree/image.png",
        "word-split-repro/1790368741038/collect-prod-source.png",
        "worktree",
      ];
      const results = yield* resolveMarkdownFilePaths({ cwd, paths });
      expect(results.slice(0, 3)).toEqual(
        paths.slice(0, 3).map((authored) => ({
          path: authored,
          absolutePath: path.join(cwd, "image.png"),
          relativePath: "image.png",
        })),
      );
      expect(results[3]).toEqual({
        path: paths[3],
        absolutePath: path.join(cwd, "worktree", "collision.txt"),
        relativePath: "worktree/collision.txt",
      });
      expect(results.slice(4)).toEqual(
        paths
          .slice(4)
          .map((authored) => ({ path: authored, absolutePath: null, relativePath: null })),
      );
    }),
  );

  it.effect("preserves document-relative links and outside files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped();
      const cwd = path.join(temp, "repo");
      const baseDir = path.join(cwd, "docs");
      yield* fs.makeDirectory(baseDir, { recursive: true });
      yield* fs.writeFileString(path.join(baseDir, "guide.md"), "guide");
      yield* fs.writeFileString(path.join(temp, "outside.txt"), "outside");
      const outside = yield* fs.realPath(path.join(temp, "outside.txt"));
      const results = yield* resolveMarkdownFilePaths({
        cwd,
        baseDir,
        paths: ["guide.md", "../../outside.txt", "docs/guide.md", "missing.md"],
      });
      expect(results).toEqual([
        {
          path: "guide.md",
          absolutePath: path.join(baseDir, "guide.md"),
          relativePath: "docs/guide.md",
        },
        { path: "../../outside.txt", absolutePath: outside, relativePath: null },
        { path: "docs/guide.md", absolutePath: null, relativePath: null },
        { path: "missing.md", absolutePath: null, relativePath: null },
      ]);
    }),
  );
});
