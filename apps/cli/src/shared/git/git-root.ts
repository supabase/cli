import { Effect, FileSystem, Option, Path } from "effect";

export const findGitRootPath = Effect.fnUntraced(function* (startPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = path.resolve(startPath);

  while (true) {
    // A failed stat means no `.git` here: keep walking until we hit the filesystem root.
    if (Option.isSome(yield* fs.stat(path.resolve(current, ".git")).pipe(Effect.option))) {
      return Option.some(current);
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return Option.none<string>();
    }
    current = parent;
  }
});
