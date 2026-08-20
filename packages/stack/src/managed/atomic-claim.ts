import { randomUUID } from "node:crypto";
import { Cause, Data, Effect, FileSystem, Option, PlatformError, Schedule } from "effect";

export type FileClaimOutcome = "claimed" | "already-exists";

export interface FileClaimOptions {
  /** Mode for the published file; defaults to the process umask. */
  readonly mode?: number;
}

class ClaimLockBusyError extends Data.TaggedError("ManagedClaimLockBusy")<{
  readonly path: string;
}> {}

const platformCauseCode = (error: PlatformError.PlatformError): string | undefined => {
  const cause = error.reason.cause;
  if (typeof cause !== "object" || cause === null) return undefined;
  const code = Reflect.get(cause, "code");
  return typeof code === "string" ? code : undefined;
};

const isAlreadyExists = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag === "AlreadyExists";

const isNotFound = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag === "NotFound";

const isHardLinkUnsupported = (error: PlatformError.PlatformError): boolean => {
  const code = platformCauseCode(error);
  return code === "EPERM" || code === "ENOTSUP";
};

const removeOwnedFile = (fs: FileSystem.FileSystem, path: string): Effect.Effect<void, never> =>
  fs.remove(path, { force: true }).pipe(Effect.ignore);

/**
 * Writes one privately owned file and removes it if the write is interrupted or
 * fails. The scope closes the handle before this effect succeeds, so callers can
 * safely publish the path atomically afterwards.
 */
const writeOwnedFile = (
  fs: FileSystem.FileSystem,
  path: string,
  content: string,
  mode: number | undefined,
): Effect.Effect<void, PlatformError.PlatformError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      let opened = false;
      const result = yield* Effect.exit(
        restore(
          Effect.scoped(
            Effect.gen(function* () {
              const file = yield* fs.open(path, { flag: "wx", mode });
              opened = true;
              yield* file.writeAll(new TextEncoder().encode(content));
            }),
          ),
        ),
      );
      if (result._tag === "Success") return;
      if (opened) yield* removeOwnedFile(fs, path);
      return yield* Effect.failCause(result.cause);
    }),
  );

const lockTimeout = (path: string): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "Busy",
    module: "FileSystem",
    method: "claimFileAtomically",
    pathOrDescriptor: path,
    description: "Timed out waiting for the managed publication lock",
  });

const publishWhileHoldingLock = (
  fs: FileSystem.FileSystem,
  temporaryPath: string,
  targetPath: string,
): Effect.Effect<FileClaimOutcome, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    // A winner may have completed between the initial observation and lock
    // acquisition. Only report already-exists after proving that it is readable.
    const existing = yield* Effect.exit(fs.readFile(targetPath));
    if (existing._tag === "Success") return "already-exists" as const;
    const existingError = Cause.findErrorOption(existing.cause);
    if (Option.isNone(existingError)) return yield* Effect.failCause(existing.cause);
    if (!isNotFound(existingError.value)) return yield* Effect.fail(existingError.value);

    const linked = yield* Effect.exit(fs.link(temporaryPath, targetPath));
    if (linked._tag === "Success") return "claimed" as const;
    const linkError = Cause.findErrorOption(linked.cause);
    if (Option.isNone(linkError)) return yield* Effect.failCause(linked.cause);
    if (isAlreadyExists(linkError.value)) {
      // The lock serializes managed claimants, but preserve the public contract
      // if an external writer wins between the read and link operations.
      const readable = yield* Effect.exit(fs.readFile(targetPath));
      if (readable._tag === "Success") return "already-exists" as const;
      return yield* Effect.failCause(readable.cause);
    }
    if (!isHardLinkUnsupported(linkError.value)) {
      return yield* Effect.fail(linkError.value);
    }

    // Hard links are unavailable on some filesystems. We own the sidecar lock,
    // so an atomic rename of the complete temporary file is the equivalent
    // publication primitive and never exposes a partial canonical target.
    yield* fs.rename(temporaryPath, targetPath);
    return "claimed" as const;
  });

const attemptClaim = (
  fs: FileSystem.FileSystem,
  temporaryPath: string,
  targetPath: string,
): Effect.Effect<FileClaimOutcome, PlatformError.PlatformError | ClaimLockBusyError> =>
  Effect.gen(function* () {
    const existing = yield* Effect.exit(fs.readFile(targetPath));
    if (existing._tag === "Success") return "already-exists" as const;
    const existingError = Cause.findErrorOption(existing.cause);
    if (Option.isNone(existingError)) return yield* Effect.failCause(existing.cause);
    if (!isNotFound(existingError.value)) return yield* Effect.fail(existingError.value);

    const lockPath = `${targetPath}.lock`;
    const lock = Effect.acquireUseRelease(
      writeOwnedFile(fs, lockPath, "managed-claim\n", 0o600).pipe(Effect.as(lockPath)),
      () => publishWhileHoldingLock(fs, temporaryPath, targetPath),
      (ownedPath) => removeOwnedFile(fs, ownedPath),
    );
    const result = yield* Effect.exit(lock);
    if (result._tag === "Success") return result.value;
    const lockError = Cause.findErrorOption(result.cause);
    if (Option.isSome(lockError) && isAlreadyExists(lockError.value)) {
      return yield* Effect.fail(new ClaimLockBusyError({ path: lockPath }));
    }
    return yield* Effect.failCause(result.cause);
  });

/**
 * Publishes `content` at `targetPath` unless a claimant got there first.
 *
 * Every claimant writes a unique sibling completely before acquiring an
 * exclusive sidecar lock. The lock serializes managed publishers, allowing the
 * hard-link path and the atomic-rename fallback to share the same no-partial-file
 * invariant. Contenders retry for a bounded period, so a crashed owner cannot
 * make callers wait forever.
 */
export const claimFileAtomically = (
  targetPath: string,
  content: string,
  options: FileClaimOptions = {},
): Effect.Effect<FileClaimOutcome, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporaryPath = `${targetPath}.tmp.${randomUUID()}`;
    const lockPath = `${targetPath}.lock`;

    const claim = attemptClaim(fs, temporaryPath, targetPath).pipe(
      Effect.retry({
        schedule: Schedule.spaced("10 millis").pipe(Schedule.upTo({ duration: "2 seconds" })),
        while: (error) => error instanceof ClaimLockBusyError,
      }),
      Effect.mapError((error) =>
        error instanceof ClaimLockBusyError ? lockTimeout(lockPath) : error,
      ),
    );

    // Bracket the temp path before entering the interruptible lock/publish
    // region. Its finalizer is exact and uninterruptible, including cancellation
    // while rename or link is suspended by a transformed FileSystem.
    return yield* Effect.acquireUseRelease(
      writeOwnedFile(fs, temporaryPath, content, options.mode).pipe(Effect.as(temporaryPath)),
      () => claim,
      (ownedPath) => removeOwnedFile(fs, ownedPath),
    );
  });
