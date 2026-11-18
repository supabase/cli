import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";

/** Description overlays keyed by docs-relative POSIX path. */
export interface DocsContent {
  readonly overlays: ReadonlyMap<string, string>;
}

export const readDocsContent = Effect.fn("docs.readDocsContent")(function* (
  docsDir: string,
): Effect.fn.Return<DocsContent, PlatformError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  /* Keeps a leading BOM, which `readFileString` strips. */
  const readUtf8 = (file: string) =>
    Effect.map(fs.readFile(file), (bytes) =>
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes),
    );
  /* Never walks a symlink, even one `readLink` is denied on (a mode-000 link on macOS); an entry
     `readLink` or `stat` cannot reach counts as a file, so a `.md` one still fails on its read. */
  const isWalkableDirectory = Effect.fnUntraced(function* (entryPath: string) {
    const isSymlinkOrDenied = yield* fs.readLink(entryPath).pipe(
      Effect.catchReason("PlatformError", "PermissionDenied", () => Effect.void),
      Effect.isSuccess,
    );
    if (isSymlinkOrDenied) return false;
    return yield* Effect.match(fs.stat(entryPath), {
      onFailure: () => false,
      onSuccess: (info) => info.type === "Directory",
    });
  });
  const overlays = new Map<string, string>();
  const walk = (dir: string): Effect.Effect<void, PlatformError> =>
    Effect.gen(function* () {
      for (const name of yield* fs.readDirectory(dir)) {
        const entryPath = path.join(dir, name);
        if (yield* isWalkableDirectory(entryPath)) yield* walk(entryPath);
        else if (name.endsWith(".md")) {
          const key = path.relative(docsDir, entryPath).split(path.sep).join("/");
          overlays.set(key, yield* readUtf8(entryPath));
        }
      }
    });
  yield* walk(path.join(docsDir, "supabase"));
  return { overlays };
});
