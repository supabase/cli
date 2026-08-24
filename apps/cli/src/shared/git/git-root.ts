import { Effect, FileSystem, Path } from "effect";

/**
 * Finds the nearest ancestor containing a `.git` entry.
 *
 * Filesystem failures intentionally have the same semantics as the previous
 * implementation: an unreadable or missing marker is treated as a miss and
 * the search continues towards the filesystem root.
 */
export const findGitRootPath: (
  startPath: string,
) => Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> =
  Effect.fnUntraced(function* (startPath: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let current = path.resolve(startPath);

    for (;;) {
      const hasGitMarker = yield* fs.stat(path.join(current, ".git")).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (hasGitMarker) {
        return current;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  });
