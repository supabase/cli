import { gzipSync } from "node:zlib";
import { Data, Effect, FileSystem, Option, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ComputeSourceEscapingLinkError } from "./compute.errors.ts";
import { createTar, type TarEntry } from "./tar.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

export class ComputeArchiveCompressionError extends Data.TaggedError(
  "ComputeArchiveCompressionError",
)<{
  readonly detail: string;
  readonly cause: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.internalPanic;
  }
}

/**
 * Packages a compute's source directory into the `.tar.gz` build context the Compute API's
 * upload slot expects. Nothing is excluded: for a `dockerfile` compute the archive is the
 * build context the user's own `Dockerfile` expects, and for a catalog runtime the server
 * synthesizes `FROM <base>` + `COPY` with no install step, so `node_modules/` is a deploy
 * dependency rather than noise. Packaged size is reported back so growth is visible before
 * the upload rather than after.
 */

interface PackagedCompute {
  readonly archive: Uint8Array;
  readonly fileCount: number;
}

/**
 * Where a symlink points, relative to the packaged tree, or `undefined` when it points
 * outside it. A link is stored rather than followed, so the target has to be packaged too for
 * the link to mean anything on the other end. Targets are rewritten relative to the link's
 * own directory, since an absolute one is a path on this machine that wouldn't resolve
 * anywhere else.
 */
function confinedLinkTarget(input: {
  readonly path: Path.Path;
  readonly root: string;
  readonly linkDir: string;
  readonly target: string;
}): string | undefined {
  const resolved = input.path.resolve(input.linkDir, input.target);
  const fromRoot = input.path.relative(input.root, resolved);
  if (fromRoot.startsWith("..") || input.path.isAbsolute(fromRoot)) {
    return undefined;
  }
  return input.path.isAbsolute(input.target)
    ? input.path.relative(input.linkDir, resolved)
    : input.target;
}

/**
 * Seconds since the epoch, as a USTAR octal field can hold them. A filesystem timestamp
 * isn't always a sane one: a pre-1970 mtime is negative (a botched `touch` or some archive
 * extractors produce them), and a corrupt one decodes to an `Invalid Date` with `NaN`. Neither
 * is worth failing a deploy over, so both collapse to the epoch instead of reaching
 * `writeOctal`'s range check.
 */
function tarMtime(modified: Option.Option<Date>): number {
  if (Option.isNone(modified)) {
    return 0;
  }
  const seconds = Math.floor(modified.value.getTime() / 1000);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : 0;
}

/**
 * Every entry under `root`, as tar entries. Filesystem errors propagate rather than being
 * skipped: an entry missing from the archive means deploying an application with a hole in
 * it, reported as a success — an unreadable directory, an unopenable file, or an entry that
 * vanishes mid-walk are all that case.
 */
const collectEntries = (
  path: Path.Path,
  root: string,
  relativeDir: string,
): Effect.Effect<
  Array<TarEntry>,
  PlatformError | ComputeSourceEscapingLinkError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const absoluteDir = relativeDir === "" ? root : path.join(root, relativeDir);

    const names = yield* fs.readDirectory(absoluteDir);
    const entries: Array<TarEntry> = [];

    for (const name of [...names].sort()) {
      const relativePath = relativeDir === "" ? name : `${relativeDir}/${name}`;
      const absolutePath = path.join(root, relativePath);

      // `readLink` succeeds only for symlinks, standing in for the `lstat` this FileSystem
      // service doesn't expose. Storing the link rather than following it keeps a
      // pnpm-installed `node_modules` from being inlined file by file, keeps a broken link
      // from vanishing, and stops a link pointing at an ancestor from being walked into.
      const linkTarget = yield* fs.readLink(absolutePath).pipe(Effect.option);
      if (Option.isSome(linkTarget)) {
        const confined = confinedLinkTarget({
          path,
          root,
          linkDir: absoluteDir,
          target: linkTarget.value,
        });
        if (confined === undefined) {
          return yield* new ComputeSourceEscapingLinkError({
            detail: `${relativePath} links to ${linkTarget.value}, which is outside the compute source and cannot be packaged with it.`,
            suggestion:
              "Install the compute's dependencies inside its own directory, or point `source` at a directory that contains everything the build needs.",
          });
        }
        entries.push({
          path: relativePath,
          contents: new Uint8Array(0),
          mode: 0o777,
          mtime: 0,
          linkTarget: confined,
        });
        continue;
      }

      const info = yield* fs.stat(absolutePath);

      const mtime = tarMtime(info.mtime);

      if (info.type === "Directory") {
        entries.push({ path: `${relativePath}/`, contents: new Uint8Array(0), mode: 0o755, mtime });
        entries.push(...(yield* collectEntries(path, root, relativePath)));
        continue;
      }

      if (info.type !== "File") {
        // Sockets, FIFOs and devices have nothing meaningful to send.
        continue;
      }

      const contents = yield* fs.readFile(absolutePath);
      // The executable bit is the only permission that changes what the image does;
      // everything else is normalized so the same tree packages identically on every
      // machine. `mode` is a plain number here, unlike the `Option`-wrapped `mtime` above.
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

export const packageComputeDirectory = Effect.fnUntraced(function* (dir: string) {
  const path = yield* Path.Path;
  const entries = yield* collectEntries(path, dir, "");

  const tar = yield* createTar(entries);
  const archive = yield* Effect.try({
    try: () => gzipSync(tar),
    catch: (cause) =>
      new ComputeArchiveCompressionError({
        detail: "The compute source archive could not be compressed.",
        cause,
      }),
  });

  return {
    archive: new Uint8Array(archive),
    fileCount: entries.filter((entry) => !entry.path.endsWith("/")).length,
  } satisfies PackagedCompute;
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
