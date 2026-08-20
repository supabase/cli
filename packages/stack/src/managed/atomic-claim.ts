import { randomUUID } from "node:crypto";
import { Cause, Effect, FileSystem, Option, PlatformError } from "effect";

export type FileClaimOutcome = "claimed" | "already-exists";

export interface FileClaimOptions {
  /** Mode for the published file; defaults to the process umask. */
  readonly mode?: number;
}

const isAlreadyExists = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag === "AlreadyExists";

const removeOwnedFile = (fs: FileSystem.FileSystem, path: string): Effect.Effect<void, never> =>
  fs.remove(path, { force: true }).pipe(Effect.ignore);

/**
 * Writes an owned file with an interruption-safe open handoff. Exclusive open
 * and ownership recording stay masked as one region; only the subsequent write
 * is restored, so a created pathname can never escape without cleanup ownership.
 */
const writeOwnedFile = (
  fs: FileSystem.FileSystem,
  path: string,
  content: string,
  mode: number | undefined,
): Effect.Effect<void, PlatformError.PlatformError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      let attempted = false;
      let owned = false;
      const result = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            // The surrounding mask covers open and this handoff assignment.
            attempted = true;
            const file = yield* fs.open(path, { flag: "wx", mode });
            owned = true;
            yield* restore(file.writeAll(new TextEncoder().encode(content)));
          }),
        ),
      );
      if (result._tag === "Success") return;
      const error = Cause.findErrorOption(result.cause);
      const interruptedBeforeOwnership =
        attempted &&
        Cause.hasInterrupts(result.cause) &&
        (Option.isNone(error) || !isAlreadyExists(error.value));
      if (owned || interruptedBeforeOwnership) {
        yield* removeOwnedFile(fs, path);
      }
      return yield* Effect.failCause(result.cause);
    }),
  );

const publish = (
  fs: FileSystem.FileSystem,
  temporaryPath: string,
  targetPath: string,
): Effect.Effect<FileClaimOutcome, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    // A hard link publishes the complete, closed temp atomically and refuses an
    // existing target. Unsupported links fail as typed PlatformError rather than
    // falling back to a direct target write or an unprovable sidecar protocol.
    const linked = yield* Effect.exit(fs.link(temporaryPath, targetPath));
    if (linked._tag === "Success") return "claimed" as const;
    const linkError = Cause.findErrorOption(linked.cause);
    if (Option.isNone(linkError)) return yield* Effect.failCause(linked.cause);
    if (isAlreadyExists(linkError.value)) {
      const readable = yield* Effect.exit(fs.readFile(targetPath));
      if (readable._tag === "Success") return "already-exists" as const;
      return yield* Effect.failCause(readable.cause);
    }
    return yield* Effect.fail(linkError.value);
  });

/**
 * Publishes `content` at `targetPath` unless a claimant got there first.
 *
 * Every claimant writes a unique sibling completely before publication. The
 * hard-link publication is the sole publication primitive: it exposes only a
 * complete temp and never overwrites a winner. Filesystems that reject hard
 * links fail as a typed PlatformError after exact temporary cleanup.
 */
export const claimFileAtomically = (
  targetPath: string,
  content: string,
  options: FileClaimOptions = {},
): Effect.Effect<FileClaimOutcome, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporaryPath = `${targetPath}.tmp.${randomUUID()}`;

    // Register exact temp cleanup before entering interruptible publication.
    return yield* Effect.acquireUseRelease(
      writeOwnedFile(fs, temporaryPath, content, options.mode).pipe(Effect.as(temporaryPath)),
      () => publish(fs, temporaryPath, targetPath),
      (ownedPath) => removeOwnedFile(fs, ownedPath),
    );
  });
