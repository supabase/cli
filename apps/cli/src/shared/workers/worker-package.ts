import { gzipSync } from "node:zlib";
import { Effect, FileSystem } from "effect";
import { createTar, type TarEntry } from "./tar.ts";

/**
 * Package a worker's source directory into the `.tar.gz` build context the
 * Workers API's upload slot expects.
 *
 * Nothing is excluded. For a `dockerfile` worker the archive is the build
 * context, so it has to be what the user's own `Dockerfile` expects to find;
 * for a catalog runtime the server synthesizes `FROM <base>` + `COPY` with no
 * install step of its own, so an installed `node_modules/` is a dependency of
 * the deploy rather than noise in it. The packaged size is reported back so a
 * directory that has grown past what anyone meant to upload is visible before
 * the upload rather than after it.
 */

interface PackagedWorker {
  readonly archive: Uint8Array;
  readonly fileCount: number;
}

const collectEntries = (
  root: string,
  relativeDir: string,
): Effect.Effect<Array<TarEntry>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const absoluteDir = relativeDir === "" ? root : `${root}/${relativeDir}`;

    const names = yield* fs
      .readDirectory(absoluteDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const entries: Array<TarEntry> = [];

    for (const name of [...names].sort()) {
      const relativePath = relativeDir === "" ? name : `${relativeDir}/${name}`;
      const absolutePath = `${root}/${relativePath}`;

      // `readLink` succeeds only for symlinks, so it stands in for the `lstat`
      // this FileSystem service does not expose (the same probe
      // `legacy-sql-files-glob.ts` uses). Storing the link rather than following
      // it is what keeps a pnpm-installed `node_modules` from being inlined file
      // by file, keeps a broken link from vanishing, and stops a link pointing at
      // an ancestor from being walked into.
      const linkTarget = yield* fs.readLink(absolutePath).pipe(Effect.option);
      if (linkTarget._tag === "Some") {
        entries.push({
          path: relativePath,
          contents: new Uint8Array(0),
          mode: 0o777,
          mtime: 0,
          linkTarget: linkTarget.value,
        });
        continue;
      }

      const info = yield* fs.stat(absolutePath).pipe(Effect.option);
      if (info._tag === "None") {
        continue;
      }

      const modified = info.value.mtime;
      const mtime = modified._tag === "Some" ? Math.floor(modified.value.getTime() / 1000) : 0;

      if (info.value.type === "Directory") {
        entries.push({ path: `${relativePath}/`, contents: new Uint8Array(0), mode: 0o755, mtime });
        entries.push(...(yield* collectEntries(root, relativePath)));
        continue;
      }

      if (info.value.type !== "File") {
        // Sockets, FIFOs and devices have nothing meaningful to send.
        continue;
      }

      const contents = yield* fs
        .readFile(absolutePath)
        .pipe(Effect.orElseSucceed(() => new Uint8Array(0)));
      // The executable bit is the only permission that changes what the image
      // does; everything else is normalized so the same tree packages
      // identically on every machine.
      const executable = (Number(info.value.mode) & 0o111) !== 0;
      entries.push({
        path: relativePath,
        contents: new Uint8Array(contents),
        mode: executable ? 0o755 : 0o644,
        mtime,
      });
    }

    return entries;
  });

export const packageWorkerDirectory = Effect.fnUntraced(function* (dir: string) {
  const entries = yield* collectEntries(dir, "");
  const archive = gzipSync(createTar(entries));

  return {
    archive: new Uint8Array(archive),
    fileCount: entries.filter((entry) => !entry.path.endsWith("/")).length,
  } satisfies PackagedWorker;
});

/** `10 KiB` / `1.4 MiB` — the packaged size, as `push` reports it. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${Math.ceil(kib)} KiB`;
  }
  return `${(kib / 1024).toFixed(1)} MiB`;
}
