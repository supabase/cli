import { Effect, FileSystem, Path, Predicate } from "effect";
import type { PlatformError } from "effect/PlatformError";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem has no non-recursive directory removal operation.
import { rmdir } from "node:fs/promises";
import { namespaceError, type NamespaceError } from "../Capabilities.ts";

/** Removes a directory only if it is already empty; any other failure propagates. */
export const removeEmptyDirectory = (directory: string): Effect.Effect<void, NamespaceError> =>
  Effect.tryPromise({
    try: () => rmdir(directory),
    catch: (cause) => namespaceError("cleanup", cause),
  }).pipe(
    Effect.catchIf(
      (error) =>
        Predicate.hasProperty(error.cause, "code") &&
        ["ENOENT", "ENOTEMPTY", "EEXIST"].includes(String(error.cause.code)),
      () => Effect.void,
    ),
  );

/** Flushes a file's contents to durable storage. */
export const fsyncFile = (
  fs: FileSystem.FileSystem,
  target: string,
): Effect.Effect<void, PlatformError> =>
  Effect.scoped(fs.open(target, { flag: "r+" }).pipe(Effect.flatMap((file) => file.sync)));

/** Flushes a directory's own metadata; a no-op on Windows, which can't open or fsync directories. */
export const fsyncDirectory = (
  fs: FileSystem.FileSystem,
  directory: string,
): Effect.Effect<void, PlatformError> =>
  process.platform === "win32"
    ? Effect.void
    : Effect.scoped(fs.open(directory, { flag: "r" }).pipe(Effect.flatMap((file) => file.sync)));

let probeCounter = 0;

/**
 * Fails before any mutation when `directory`'s filesystem cannot hard-link within itself.
 * Unsupported, by maintainer decision, rather than falling back to a non-atomic publish. The probe
 * name is unique per call, so concurrent acquisitions under the same root never collide on it.
 */
export const assertHardLinkSupport = Effect.fn("Namespace.assertHardLinkSupport")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
) {
  const probe = path.join(directory, `.namespace-hardlink-probe-${process.pid}-${++probeCounter}`);
  const probeLink = `${probe}.link`;
  const cleanup = Effect.all(
    [
      fs.remove(probe, { force: true }).pipe(Effect.ignore),
      fs.remove(probeLink, { force: true }).pipe(Effect.ignore),
    ],
    { discard: true },
  );
  const supported = yield* fs.writeFileString(probe, "").pipe(
    Effect.mapError((cause) => namespaceError("hardlink-support", cause)),
    Effect.andThen(fs.link(probe, probeLink).pipe(Effect.isSuccess)),
    Effect.ensuring(cleanup),
  );
  if (!supported)
    return yield* namespaceError(
      "hardlink-support",
      `${directory} is on a filesystem without hard-link support, which the stack namespace requires for atomic publication`,
    );
});
