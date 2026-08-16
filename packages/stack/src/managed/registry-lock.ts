import { randomUUID } from "node:crypto";
import {
  Cause,
  Data,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Path,
  PlatformError,
  Schedule,
  Schema,
} from "effect";
import { claimFileAtomically } from "./atomic-claim.ts";
import { resolveManagedStateRoot } from "./paths.ts";

const REGISTRY_LOCK_MAX_AGE_MS = 30_000;

interface RegistryLockDocument {
  readonly token: string;
  readonly pid: number;
  readonly acquiredAt: string;
}

const registryLockSchema = Schema.Struct({
  token: Schema.String,
  pid: Schema.Number,
  acquiredAt: Schema.String,
});

const decodeRegistryLock = Schema.decodeUnknownSync(registryLockSchema);

export class RegistryLockBusyError extends Data.TaggedError("RegistryLockBusyError")<{
  readonly path: string;
}> {
  override get message(): string {
    return `Managed registry is busy: ${this.path}`;
  }
}

export class RegistryLockClaimError extends Data.TaggedError("RegistryLockClaimError")<{
  readonly operation: "claim" | "rename";
  readonly path: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Managed registry lock claim failed (${this.path})`;
  }
}

export interface RegistryLockOptions {
  /** A focused timing seam for contention tests; production uses a bounded schedule. */
  readonly retrySchedule?: Schedule.Schedule<unknown>;
  /** Override the host PID probe in tests or platform adapters. */
  readonly isProcessAlive?: (pid: number) => Effect.Effect<boolean>;
}

const defaultRetrySchedule = (): Schedule.Schedule<unknown> =>
  Schedule.exponential(Duration.millis(25)).pipe(Schedule.upTo({ duration: Duration.seconds(5) }));

const defaultIsProcessAlive = (pid: number): Effect.Effect<boolean> =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return false;
      }
      // EPERM and all other probe failures are deliberately treated as alive:
      // an unprobeable owner must never be reclaimed by this small lock.
      return true;
    }
  });

const readExistingLock = (
  fs: FileSystem.FileSystem,
  lockPath: string,
): Effect.Effect<RegistryLockDocument | undefined, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    if (!(yield* fs.exists(lockPath))) {
      return undefined;
    }
    const content = yield* fs.readFileString(lockPath);
    return yield* Effect.sync(() => {
      try {
        return decodeRegistryLock(JSON.parse(content));
      } catch {
        return undefined;
      }
    });
  });

const isReclaimable = (
  lock: RegistryLockDocument,
  isProcessAlive: (pid: number) => Effect.Effect<boolean>,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const acquiredAt = Date.parse(lock.acquiredAt);
    if (!Number.isFinite(acquiredAt) || Date.now() - acquiredAt < REGISTRY_LOCK_MAX_AGE_MS) {
      return false;
    }
    return !(yield* isProcessAlive(lock.pid));
  });

const acquireRegistryLock = (
  fs: FileSystem.FileSystem,
  lockPath: string,
  options: RegistryLockOptions,
): Effect.Effect<
  RegistryLockDocument,
  RegistryLockBusyError | PlatformError.PlatformError | RegistryLockClaimError
> => {
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const tryClaim = (
    lock: RegistryLockDocument,
  ): Effect.Effect<"claimed" | "already-exists", RegistryLockClaimError> =>
    Effect.tryPromise({
      try: () =>
        claimFileAtomically(lockPath, JSON.stringify(lock) + "\n", {
          mode: 0o600,
          temporaryId: lock.token,
        }),
      catch: (cause) => new RegistryLockClaimError({ operation: "claim", path: lockPath, cause }),
    });

  return Effect.gen(function* () {
    const lock: RegistryLockDocument = {
      token: randomUUID(),
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    const outcome = yield* tryClaim(lock);
    if (outcome === "claimed") {
      return lock;
    }

    const existing = yield* readExistingLock(fs, lockPath);
    if (existing !== undefined && (yield* isReclaimable(existing, isProcessAlive))) {
      const current = yield* readExistingLock(fs, lockPath);
      if (
        current === undefined ||
        current.token !== existing.token ||
        !(yield* isReclaimable(current, isProcessAlive))
      ) {
        return yield* new RegistryLockBusyError({ path: lockPath });
      }

      const quarantinePath = `${lockPath}.stale.${lock.token}`;
      const moved = yield* Effect.exit(fs.rename(lockPath, quarantinePath));
      if (Exit.isFailure(moved)) {
        const error = Cause.squash(moved.cause);
        if (error instanceof PlatformError.PlatformError && error.reason._tag === "NotFound") {
          return yield* new RegistryLockBusyError({ path: lockPath });
        }
        if (error instanceof PlatformError.PlatformError) {
          return yield* Effect.fail(error);
        }
        return yield* new RegistryLockClaimError({
          operation: "rename",
          path: lockPath,
          cause: error,
        });
      }

      const reclaimed = yield* Effect.ensuring(
        tryClaim(lock),
        fs.remove(quarantinePath, { force: true }).pipe(Effect.catch(() => Effect.void)),
      );
      if (reclaimed === "claimed") {
        return lock;
      }
    }
    return yield* new RegistryLockBusyError({ path: lockPath });
  });
};

const releaseRegistryLock = (
  fs: FileSystem.FileSystem,
  lockPath: string,
  owned: RegistryLockDocument,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const current = yield* readExistingLock(fs, lockPath);
    if (current?.token === owned.token) {
      yield* fs.remove(lockPath, { force: true });
    }
  }).pipe(Effect.catch(() => Effect.void));

export const withRegistryLock = <A, E, R>(
  stateRoot: string,
  effect: Effect.Effect<A, E, R>,
  options: RegistryLockOptions = {},
): Effect.Effect<
  A,
  E | RegistryLockBusyError | PlatformError.PlatformError | RegistryLockClaimError,
  R | FileSystem.FileSystem | Path.Path
> => {
  const resolvedStateRoot = resolveManagedStateRoot({ stateRoot });
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lockPath = path.join(resolvedStateRoot, "registry.lock");
      yield* fs.makeDirectory(resolvedStateRoot, { recursive: true, mode: 0o700 });
      yield* Effect.acquireRelease(
        Effect.retry(acquireRegistryLock(fs, lockPath, options), {
          while: (error) => error instanceof RegistryLockBusyError,
          schedule: options.retrySchedule ?? defaultRetrySchedule(),
        }),
        (owned) => releaseRegistryLock(fs, lockPath, owned),
      );
      return yield* effect;
    }),
  );
};
