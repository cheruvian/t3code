// @effect-diagnostics nodeBuiltinImport:off -- this adapter acquires a native watcher eagerly; FileSystem.watch registers lazily.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/** Acquire before returning so edits cannot race lazy stream registration. */
export const watchFile = Effect.fnUntraced(function* (filePath: string) {
  const directory = NodePath.dirname(filePath);
  const resolved = NodePath.resolve(filePath);
  const changed = yield* Queue.make<void, PlatformError.PlatformError | Cause.Done>({
    capacity: 1,
    strategy: "sliding",
  });
  const watchError = (cause: unknown) =>
    PlatformError.systemError({
      module: "FileSystem",
      method: "watch",
      _tag: "Unknown",
      pathOrDescriptor: directory,
      cause,
    });
  yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const watcher = NodeFS.watch(directory, (_event, fileName) => {
          // A missing filename means the directory changed without a precise
          // target. Revalidate rather than silently losing the notification.
          if (fileName === null || NodePath.resolve(directory, fileName) === resolved) {
            Queue.offerUnsafe(changed, undefined);
          }
        });
        watcher.on("error", (cause) =>
          Queue.failCauseUnsafe(changed, Cause.fail(watchError(cause))),
        );
        watcher.on("close", () => Queue.endUnsafe(changed));
        return watcher;
      },
      catch: watchError,
    }),
    (watcher) =>
      Effect.sync(() => {
        watcher.close();
        Queue.shutdownUnsafe(changed);
      }),
  );
  return Stream.fromQueue(changed);
});
