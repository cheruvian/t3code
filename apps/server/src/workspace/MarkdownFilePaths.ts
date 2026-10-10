import type { ProjectResolveFilePathsInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Resolves presentation metadata only; never changes stored messages or agent context. */
export const resolveMarkdownFilePaths = Effect.fn("resolveMarkdownFilePaths")(function* (
  input: ProjectResolveFilePathsInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(input.cwd);
  const base = path.resolve(input.baseDir ?? root);
  const realRoot = yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => root));
  const relativeWithinRoot = (absolutePath: string) => {
    const relative = path.relative(realRoot, absolutePath);
    return relative &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
      ? relative.split(path.sep).join("/")
      : null;
  };
  const realFile = Effect.fn(function* (candidate: string) {
    const realPath = yield* fs.realPath(candidate);
    const stat = yield* fs.stat(realPath);
    return stat.type === "File" ? realPath : null;
  });
  return yield* Effect.forEach(
    [...new Set(input.paths)],
    (authored) =>
      Effect.gen(function* () {
        const literal = path.resolve(base, authored);
        const found = yield* realFile(literal).pipe(Effect.result);
        let absolutePath = found._tag === "Success" ? found.success : null;
        // Only retry a missing bare root-prefixed path. Explicit ./ and ../ retain
        // their meaning, and an existing child with the same name always wins.
        if (
          found._tag === "Failure" &&
          found.failure.reason._tag === "NotFound" &&
          base === root &&
          !path.isAbsolute(authored)
        ) {
          const segments = authored.split(path.sep === "\\" ? /[\\/]/ : /\//);
          const first = segments[0];
          const rootName = path.basename(root);
          const matches =
            path.sep === "\\"
              ? first?.toLowerCase() === rootName.toLowerCase()
              : first === rootName;
          if (matches && segments.length > 1 && !segments.includes("..")) {
            const corrected = yield* realFile(path.resolve(root, ...segments.slice(1))).pipe(
              Effect.orElseSucceed(() => null),
            );
            if (corrected && relativeWithinRoot(corrected)) absolutePath = corrected;
          }
        }
        const relativePath = absolutePath ? relativeWithinRoot(absolutePath) : null;
        // Use the configured root as the stable spelling of files inside the workspace,
        // even when the author used its realpath alias.
        return {
          path: authored,
          absolutePath: relativePath ? path.resolve(root, relativePath) : absolutePath,
          relativePath,
        };
      }),
    { concurrency: 8 },
  );
});
