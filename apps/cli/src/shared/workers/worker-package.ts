import { gzipSync } from "node:zlib";
import { Effect, FileSystem, Option } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { createTar, type TarEntry, TarPathTooLongError } from "./tar.ts";

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

/**
 * Seconds since the epoch, as a USTAR octal field can hold them.
 *
 * A filesystem timestamp is not always a sane one. A pre-1970 mtime is negative
 * — a botched `touch` and some archive extractors both produce them — and a
 * corrupt one decodes to an `Invalid Date` whose `getTime()` is `NaN`. Neither
 * is representable, and neither is worth failing a deploy over, so both collapse
 * to the epoch rather than reaching `writeOctal`'s range check.
 */
function tarMtime(modified: Option.Option<Date>): number {
  if (Option.isNone(modified)) {
    return 0;
  }
  const seconds = Math.floor(modified.value.getTime() / 1000);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : 0;
}

/**
 * Every entry under `root`, as tar entries.
 *
 * Filesystem errors propagate rather than being skipped: an entry missing from
 * the archive means deploying an application with a hole in it, reported as a
 * success. A directory the walk cannot read, a file it cannot open and an entry
 * that vanishes mid-walk are all that case.
 */
const collectEntries = (
  root: string,
  relativeDir: string,
): Effect.Effect<Array<TarEntry>, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const absoluteDir = relativeDir === "" ? root : `${root}/${relativeDir}`;

    const names = yield* fs.readDirectory(absoluteDir);
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
      if (Option.isSome(linkTarget)) {
        entries.push({
          path: relativePath,
          contents: new Uint8Array(0),
          mode: 0o777,
          mtime: 0,
          linkTarget: linkTarget.value,
        });
        continue;
      }

      const info = yield* fs.stat(absolutePath);

      const mtime = tarMtime(info.mtime);

      if (info.type === "Directory") {
        entries.push({ path: `${relativePath}/`, contents: new Uint8Array(0), mode: 0o755, mtime });
        entries.push(...(yield* collectEntries(root, relativePath)));
        continue;
      }

      if (info.type !== "File") {
        // Sockets, FIFOs and devices have nothing meaningful to send.
        continue;
      }

      const contents = yield* fs.readFile(absolutePath);
      // The executable bit is the only permission that changes what the image
      // does; everything else is normalized so the same tree packages
      // identically on every machine. `mode` is a plain number here, unlike the
      // `Option`-wrapped `mtime` above.
      const executable = (info.mode & 0o111) !== 0;
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

  // `createTar` throws for a name USTAR cannot represent, such as a path
  // component over 100 bytes. That is user-actionable, so it belongs in the
  // failure channel: `withJsonErrorHandling` only catches failures, and a defect
  // would exit `--output-format json` with no structured error.
  const archive = yield* Effect.try({
    try: () => gzipSync(createTar(entries)),
    catch: (cause) => {
      if (cause instanceof TarPathTooLongError) {
        return cause;
      }
      // Anything else here really is a bug, so let it stay a defect rather than
      // dressing it up as a failure the user could act on.
      throw cause;
    },
  });

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
