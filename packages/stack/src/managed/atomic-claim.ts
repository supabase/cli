import { randomUUID } from "node:crypto";
import { Cause, Effect, FileSystem, Option, PlatformError } from "effect";

export type FileClaimOutcome = "claimed" | "already-exists";

export interface FileClaimOptions {
  /** Mode for the published file; defaults to the process umask. */
  readonly mode?: number;
}

const platformCauseCode = (error: PlatformError.PlatformError): string | undefined => {
  const cause = error.reason.cause;
  if (typeof cause !== "object" || cause === null) return undefined;
  const code = Reflect.get(cause, "code");
  return typeof code === "string" ? code : undefined;
};

const isAlreadyExists = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag === "AlreadyExists";

const isHardLinkUnsupported = (error: PlatformError.PlatformError): boolean => {
  const code = platformCauseCode(error);
  return code === "EPERM" || code === "ENOTSUP";
};

const removeOwnedFile = (fs: FileSystem.FileSystem, path: string): Effect.Effect<void, never> =>
  fs.remove(path, { force: true }).pipe(Effect.ignore);

/**
 * Publishes `content` at `targetPath` unless a claimant got there first.
 *
 * The content is first written to a unique sibling and then hardlinked into
 * place. A link publishes a complete file in one filesystem operation and
 * refuses an existing target, so a concurrent claimant cannot observe a
 * partial marker. Filesystems without hardlinks fall back to an exclusive
 * target create; that path still removes an interrupted partial target before
 * returning the failure. Every temporary and fallback-owned path is cleaned
 * up by an uninterruptible finalizer.
 */
export const claimFileAtomically = (
  targetPath: string,
  content: string,
  options: FileClaimOptions = {},
): Effect.Effect<FileClaimOutcome, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporaryPath = `${targetPath}.tmp.${randomUUID()}`;

    const publish = Effect.gen(function* () {
      // Opening exclusively through a scoped handle makes both the creation
      // and the write cancellation-aware; the outer cleanup removes a file
      // opened before an interruption can reach this continuation.
      const writeTemporary = Effect.scoped(
        fs
          .open(temporaryPath, { flag: "wx", mode: options.mode })
          .pipe(Effect.flatMap((file) => file.writeAll(new TextEncoder().encode(content)))),
      );
      yield* writeTemporary;

      const linked = yield* Effect.exit(fs.link(temporaryPath, targetPath));
      if (linked._tag === "Success") return "claimed" as const;
      const failure = Cause.findErrorOption(linked.cause);
      if (Option.isNone(failure)) return yield* Effect.failCause(linked.cause);
      const linkError = failure.value;
      if (isAlreadyExists(linkError)) return "already-exists" as const;
      if (!isHardLinkUnsupported(linkError)) return yield* Effect.fail(linkError);

      // A filesystem without hardlinks still has an exclusive create. Track
      // ownership so a cancelled write removes only the file this publisher
      // opened; a completed write leaves the winner intact.
      let targetCreated = false;
      const fallback = yield* Effect.exit(
        Effect.uninterruptibleMask((restore) =>
          Effect.scoped(
            fs.open(targetPath, { flag: "wx", mode: options.mode }).pipe(
              Effect.tap(() => Effect.sync(() => (targetCreated = true))),
              Effect.flatMap((file) => restore(file.writeAll(new TextEncoder().encode(content)))),
            ),
          ),
        ),
      );
      if (fallback._tag === "Success") return "claimed" as const;
      const fallbackFailure = Cause.findErrorOption(fallback.cause);
      if (Option.isSome(fallbackFailure) && isAlreadyExists(fallbackFailure.value)) {
        return "already-exists" as const;
      }
      if (targetCreated) {
        yield* Effect.uninterruptible(removeOwnedFile(fs, targetPath));
      }
      return yield* Effect.failCause(fallback.cause);
    });

    const result = yield* Effect.exit(publish);
    // This finalizer is deliberately outside the interruptible publication:
    // it runs after any failure or interruption and cannot strand our sibling.
    yield* Effect.uninterruptible(removeOwnedFile(fs, temporaryPath));
    return result._tag === "Success" ? result.value : yield* Effect.failCause(result.cause);
  });
