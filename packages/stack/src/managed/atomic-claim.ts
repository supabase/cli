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

interface ClaimLockOwner {
  readonly token: string;
  readonly pid: number;
  readonly tempPath: string;
  readonly encoded: string;
}

interface ClaimLockSnapshot {
  readonly raw: string;
  readonly owner: ClaimLockOwner | undefined;
}

const LOCK_STALE_AGE_MS = 30_000;

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

const readRawLock = (
  fs: FileSystem.FileSystem,
  lockPath: string,
): Effect.Effect<string | undefined, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(fs.readFileString(lockPath));
    if (result._tag === "Success") return result.value;
    const error = Cause.findErrorOption(result.cause);
    if (Option.isSome(error) && isNotFound(error.value)) return undefined;
    return yield* Effect.failCause(result.cause);
  });

const decodeLockOwner = (raw: string, targetPath: string): ClaimLockOwner | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const token = Reflect.get(value, "token");
  const pid = Reflect.get(value, "pid");
  const ownerTempPath = Reflect.get(value, "tempPath");
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    typeof ownerTempPath !== "string" ||
    ownerTempPath.length === 0 ||
    !ownerTempPath.startsWith(`${targetPath}.tmp.`)
  ) {
    return undefined;
  }
  return { token, pid, tempPath: ownerTempPath, encoded: raw };
};

const readLockSnapshot = (
  fs: FileSystem.FileSystem,
  lockPath: string,
  targetPath: string,
): Effect.Effect<ClaimLockSnapshot | undefined, PlatformError.PlatformError> =>
  Effect.map(readRawLock(fs, lockPath), (raw) =>
    raw === undefined ? undefined : { raw, owner: decodeLockOwner(raw, targetPath) },
  );

const isProcessDead = (pid: number): Effect.Effect<boolean> =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (cause) {
      if (typeof cause !== "object" || cause === null) return false;
      return Reflect.get(cause, "code") === "ESRCH";
    }
  });

const isMalformedLockOld = (
  fs: FileSystem.FileSystem,
  lockPath: string,
): Effect.Effect<boolean, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(fs.stat(lockPath));
    if (result._tag === "Failure") {
      const error = Cause.findErrorOption(result.cause);
      if (Option.isSome(error) && isNotFound(error.value)) return false;
      return yield* Effect.failCause(result.cause);
    }
    return (
      Option.isSome(result.value.mtime) &&
      Date.now() - result.value.mtime.value.getTime() >= LOCK_STALE_AGE_MS
    );
  });

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

const lockTimeout = (path: string): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "Busy",
    module: "FileSystem",
    method: "claimFileAtomically",
    pathOrDescriptor: path,
    description: "Timed out waiting for the managed publication lock",
  });

const makeLockOwner = (temporaryPath: string): ClaimLockOwner => {
  const token = randomUUID();
  const owner = { token, pid: process.pid, tempPath: temporaryPath };
  return { ...owner, encoded: `${JSON.stringify(owner)}\n` };
};

const releaseOwnedLock = (
  fs: FileSystem.FileSystem,
  lockPath: string,
  owner: ClaimLockOwner,
): Effect.Effect<void, never> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const raw = yield* readRawLock(fs, lockPath).pipe(Effect.orElseSucceed(() => undefined));
      if (raw === owner.encoded) yield* removeOwnedFile(fs, lockPath);
    }),
  );

/**
 * Reclaims a lock only after proving the recorded owner is dead (or a malformed
 * record is sufficiently old). The lock content is re-read immediately before
 * removal and again afterwards so a live replacement is never intentionally
 * removed. A recorded orphan temp is exact and safe to clean with the lock.
 */
const reclaimStaleLock = (
  fs: FileSystem.FileSystem,
  lockPath: string,
  targetPath: string,
): Effect.Effect<boolean, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const snapshot = yield* readLockSnapshot(fs, lockPath, targetPath);
    if (snapshot === undefined) return false;
    const stale =
      snapshot.owner === undefined
        ? yield* isMalformedLockOld(fs, lockPath)
        : yield* isProcessDead(snapshot.owner.pid);
    if (!stale) return false;

    const confirmed = yield* readRawLock(fs, lockPath);
    if (confirmed !== snapshot.raw) return false;
    yield* fs.remove(lockPath, { force: true });
    const after = yield* readRawLock(fs, lockPath);
    if (after === snapshot.raw) return false;
    if (snapshot.owner !== undefined) {
      yield* removeOwnedFile(fs, snapshot.owner.tempPath);
    }
    return true;
  });

const publishWhileHoldingLock = (
  fs: FileSystem.FileSystem,
  temporaryPath: string,
  targetPath: string,
): Effect.Effect<FileClaimOutcome, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    // A winner may have completed between lock acquisition and publication.
    const existing = yield* Effect.exit(fs.readFile(targetPath));
    if (existing._tag === "Success") return "already-exists" as const;
    const existingError = Cause.findErrorOption(existing.cause);
    if (Option.isNone(existingError)) return yield* Effect.failCause(existing.cause);
    if (!isNotFound(existingError.value)) return yield* Effect.fail(existingError.value);
    yield* fs.rename(temporaryPath, targetPath);
    return "claimed" as const;
  });

const publishWithFallbackLock = (
  fs: FileSystem.FileSystem,
  temporaryPath: string,
  targetPath: string,
): Effect.Effect<FileClaimOutcome, PlatformError.PlatformError | ClaimLockBusyError> =>
  Effect.gen(function* () {
    const lockPath = `${targetPath}.lock`;
    const owner = makeLockOwner(temporaryPath);
    const lock = Effect.acquireUseRelease(
      writeOwnedFile(fs, lockPath, owner.encoded, 0o600).pipe(Effect.as(owner)),
      () => publishWhileHoldingLock(fs, temporaryPath, targetPath),
      (heldOwner) => releaseOwnedLock(fs, lockPath, heldOwner),
    );
    const result = yield* Effect.exit(lock);
    if (result._tag === "Success") return result.value;
    const lockError = Cause.findErrorOption(result.cause);
    if (Option.isSome(lockError) && isAlreadyExists(lockError.value)) {
      const reclaimed = yield* reclaimStaleLock(fs, lockPath, targetPath);
      if (reclaimed) return yield* Effect.fail(new ClaimLockBusyError({ path: lockPath }));
      return yield* Effect.fail(new ClaimLockBusyError({ path: lockPath }));
    }
    return yield* Effect.failCause(result.cause);
  });

const publish = (
  fs: FileSystem.FileSystem,
  temporaryPath: string,
  targetPath: string,
): Effect.Effect<FileClaimOutcome, PlatformError.PlatformError | ClaimLockBusyError> =>
  Effect.gen(function* () {
    // The hard-link attempt is the primary publication primitive. It is atomic,
    // complete, and non-overwriting, and therefore needs no sidecar lock.
    const linked = yield* Effect.exit(fs.link(temporaryPath, targetPath));
    if (linked._tag === "Success") return "claimed" as const;
    const linkError = Cause.findErrorOption(linked.cause);
    if (Option.isNone(linkError)) return yield* Effect.failCause(linked.cause);
    if (isAlreadyExists(linkError.value)) {
      const readable = yield* Effect.exit(fs.readFile(targetPath));
      if (readable._tag === "Success") return "already-exists" as const;
      return yield* Effect.failCause(readable.cause);
    }
    if (!isHardLinkUnsupported(linkError.value)) return yield* Effect.fail(linkError.value);
    return yield* publishWithFallbackLock(fs, temporaryPath, targetPath);
  });

/**
 * Publishes `content` at `targetPath` unless a claimant got there first.
 *
 * Every claimant writes a unique sibling completely before publication. The
 * hard-link path does not need coordination; only filesystems without hard-link
 * support use a token/PID sidecar lock and atomic rename fallback.
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
    const claim = publish(fs, temporaryPath, targetPath).pipe(
      Effect.retry({
        schedule: Schedule.spaced("10 millis").pipe(Schedule.upTo({ duration: "2 seconds" })),
        while: (error) => error instanceof ClaimLockBusyError,
      }),
      Effect.mapError((error) =>
        error instanceof ClaimLockBusyError ? lockTimeout(lockPath) : error,
      ),
    );

    // Register exact temp cleanup before entering interruptible publication.
    return yield* Effect.acquireUseRelease(
      writeOwnedFile(fs, temporaryPath, content, options.mode).pipe(Effect.as(temporaryPath)),
      () => claim,
      (ownedPath) => removeOwnedFile(fs, ownedPath),
    );
  });
