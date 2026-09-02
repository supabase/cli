import { Crypto, Data, Effect, Exit, FileSystem, Path, Predicate, Schedule, Schema } from "effect";
import {
  InvalidProjectRootError,
  StackStateFormatUnsupportedError,
  StackStateInvalidError,
} from "../public/Errors.ts";
import { resolveStackPaths, type StackPaths } from "./Paths.ts";
import { deriveStackId } from "../identity/Identity.ts";
import { StackIdSchema } from "../public/StackId.ts";
import {
  PersistedStackStateSchema,
  STACK_STATE_FORMAT,
  type PersistedStackState,
} from "./StackState.ts";
import {
  acquirePortLease,
  installLease,
  readOwnerLock,
  removeLeaseIfHeld,
  writeLockTemp,
  type OwnerLock,
  OWNER_LOCK_FORMAT,
} from "./Ownership.ts";

class RegistryBusyError extends Data.TaggedError("RegistryBusyError")<{}> {}

export interface StackStateStore {
  /** Reads without taking the registry lock. `undefined` means an unconfigured identity. */
  readonly read: (
    stackId: string,
  ) => Effect.Effect<
    PersistedStackState | undefined,
    InvalidProjectRootError | StackStateInvalidError | StackStateFormatUnsupportedError,
    FileSystem.FileSystem | Path.Path | Crypto.Crypto
  >;
  /** Initializes one identity atomically, returning the winner's complete state. */
  readonly initialize: (
    stackId: string,
    state: PersistedStackState,
  ) => Effect.Effect<
    PersistedStackState,
    InvalidProjectRootError | StackStateInvalidError | StackStateFormatUnsupportedError,
    FileSystem.FileSystem | Path.Path | Crypto.Crypto
  >;
  /** Replaces one complete state value while holding the registry lock. */
  readonly replace: (
    stackId: string,
    state: PersistedStackState,
  ) => Effect.Effect<
    void,
    InvalidProjectRootError | StackStateInvalidError | StackStateFormatUnsupportedError,
    FileSystem.FileSystem | Path.Path | Crypto.Crypto
  >;
  /** Internal transaction primitive for callers that already hold the registry lock. */
  readonly replaceUnlocked: (
    stackId: string,
    state: PersistedStackState,
  ) => Effect.Effect<
    void,
    InvalidProjectRootError | StackStateInvalidError | StackStateFormatUnsupportedError,
    FileSystem.FileSystem | Path.Path | Crypto.Crypto
  >;
  /** Explicit, exact-identity destructive cleanup. Ordinary lifecycle paths never call this. */
  readonly cleanup: (
    stackId: string,
  ) => Effect.Effect<
    void,
    InvalidProjectRootError | StackStateInvalidError,
    FileSystem.FileSystem | Path.Path
  >;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stateError = (message: string, cause?: unknown) =>
  new StackStateInvalidError({ message, ...(cause === undefined ? {} : { cause }) });

const validateId = (stackId: string) =>
  Schema.decodeEffect(StackIdSchema)(stackId).pipe(
    Effect.mapError((error) => stateError(`Invalid StackId: ${String(error)}`)),
  );

const decodeState = (
  raw: unknown,
): Effect.Effect<
  PersistedStackState,
  StackStateInvalidError | StackStateFormatUnsupportedError
> => {
  if (!isRecord(raw)) return Effect.fail(stateError("Persisted stack state must be an object"));
  if (typeof raw.format !== "string")
    return Effect.fail(stateError("Persisted stack state format is missing or invalid"));
  if (raw.format !== STACK_STATE_FORMAT) {
    return Effect.fail(
      new StackStateFormatUnsupportedError({
        format: raw.format,
        message: `Unsupported stack state format; expected ${STACK_STATE_FORMAT}`,
      }),
    );
  }
  if (!isRecord(raw.secrets))
    return Effect.fail(stateError("Persisted secret values must be a record"));
  // Schema.Record validates values but does not enforce dynamic object-key checks
  // while decoding JSON, so retain this format-level slot-name guard.
  for (const slot of Object.keys(raw.secrets))
    if (!/^[A-Za-z0-9_.:/-]+$/.test(slot))
      return Effect.fail(stateError(`Persisted secret slot key is invalid: ${slot}`));
  return Schema.decodeUnknownEffect(PersistedStackStateSchema)(raw, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError((error) => stateError(`Invalid persisted stack state: ${String(error)}`)),
  );
};

const ownerDirectory = (fs: FileSystem.FileSystem, directory: string) =>
  fs
    .makeDirectory(directory, { recursive: true, mode: 0o700 })
    .pipe(Effect.flatMap(() => fs.chmod(directory, 0o700)));

const validateIdentityForStackId = (
  identity: PersistedStackState["identity"],
  stackId: string,
): Effect.Effect<void, StackStateInvalidError, Crypto.Crypto> => {
  const { stackId: persistedStackId, ...tuple } = identity;
  return deriveStackId(tuple).pipe(
    Effect.mapError((error) =>
      stateError(`Unable to validate persisted identity: ${error.message}`),
    ),
    Effect.flatMap((derived) =>
      persistedStackId === stackId && derived === stackId
        ? Effect.void
        : Effect.fail(stateError("Persisted identity does not match its StackId directory")),
    ),
  );
};

const validateStateSchema = (
  state: PersistedStackState,
): Effect.Effect<void, StackStateInvalidError> =>
  Schema.decodeEffect(PersistedStackStateSchema)(state, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError((error) => stateError(`Invalid persisted stack state: ${String(error)}`)),
    Effect.asVoid,
  );

const atomicWrite = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  crypto: Crypto.Crypto,
  statePath: string,
  stackRoot: string,
  state: PersistedStackState,
): Effect.Effect<void, StackStateInvalidError> =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(PersistedStackStateSchema)(state).pipe(
      Effect.mapError((error) =>
        stateError(`Unable to encode persisted stack state: ${String(error)}`),
      ),
    );
    const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(PersistedStackStateSchema))(
      encoded,
    ).pipe(
      Effect.mapError((error) =>
        stateError(`Unable to encode persisted stack state JSON: ${String(error)}`),
      ),
    );
    const token = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((error) =>
        stateError(`Unable to allocate state temporary name: ${error.message}`),
      ),
    );
    const temporary = path.join(stackRoot, `.state.${token}.tmp`);
    yield* Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs
            .open(temporary, { flag: "wx", mode: 0o600 })
            .pipe(
              Effect.mapError((error) =>
                stateError(`Unable to open temporary state: ${error.message}`),
              ),
            );
          yield* file
            .writeAll(new TextEncoder().encode(serialized))
            .pipe(
              Effect.mapError((error) =>
                stateError(`Unable to write temporary state: ${error.message}`),
              ),
            );
          yield* file.sync.pipe(
            Effect.mapError((error) =>
              stateError(`Unable to sync temporary state: ${error.message}`),
            ),
          );
        }),
      );
      yield* fs
        .rename(temporary, statePath)
        .pipe(
          Effect.mapError((error) =>
            stateError(`Unable to atomically replace state: ${error.message}`),
          ),
        );
    }).pipe(
      Effect.ensuring(
        fs
          .remove(temporary, { force: true })
          .pipe(Effect.catchTag("PlatformError", () => Effect.void)),
      ),
    );
    yield* fs
      .chmod(statePath, 0o600)
      .pipe(
        Effect.mapError((error) => stateError(`Unable to secure state document: ${error.message}`)),
      );
    // Effect Platform has no portable directory-fsync operation; file sync plus same-directory
    // rename is the strongest cross-platform atomicity guarantee available here.
  });

const validateState = (
  stackId: string,
  state: PersistedStackState,
): Effect.Effect<void, StackStateInvalidError, Crypto.Crypto> =>
  Effect.gen(function* () {
    yield* validateIdentityForStackId(state.identity, stackId);
    yield* validateStateSchema(state);
  });

const persistValidatedState = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  crypto: Crypto.Crypto,
  paths: StackPaths,
  state: PersistedStackState,
): Effect.Effect<void, StackStateInvalidError> =>
  Effect.gen(function* () {
    yield* ownerDirectory(fs, paths.stackRoot).pipe(
      Effect.mapError((error) =>
        stateError(`Unable to create stack state directory: ${error.message}`),
      ),
    );
    yield* atomicWrite(fs, path, crypto, paths.stateDocument, paths.stackRoot, state);
  });

/** Acquires one short cross-process lock using the same OS-held lease as Supervisor ownership. */
export const withRegistryLock = <A, E, R>(
  stateRoot: string,
  action: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | StackStateInvalidError, R | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(stateRoot);
    yield* fs
      .makeDirectory(root, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.mapError((error) =>
          stateError(`Unable to create stack registry root: ${error.message}`),
        ),
      );
    yield* fs
      .chmod(root, 0o700)
      .pipe(
        Effect.mapError((error) =>
          stateError(`Unable to secure stack registry root: ${error.message}`),
        ),
      );
    const lockPath = path.join(root, ".stack-registry.lock");
    const acquire = Effect.suspend(() =>
      Effect.gen(function* () {
        const existing = yield* readOwnerLock(fs, lockPath);
        const held = yield* acquirePortLease(existing?.port ?? 0).pipe(
          Effect.mapError((error) =>
            existing !== undefined && error["code"] === "EADDRINUSE"
              ? new RegistryBusyError()
              : error,
          ),
        );
        const install = Effect.gen(function* () {
          const token = yield* Effect.try({
            // Registry tokens are ephemeral identity labels; ownership is proven
            // by the held loopback lease and atomic canonical link.
            // oxlint-disable-next-line effecttsgo/crypto-random-uuid-in-effect
            try: () => globalThis.crypto.randomUUID(),
            catch: (cause) =>
              stateError(`Unable to allocate registry lock token: ${String(cause)}`),
          });
          const lock: OwnerLock = { format: OWNER_LOCK_FORMAT, token, port: held.port };
          const temporary = yield* writeLockTemp(fs, path, lockPath, lock);
          yield* installLease({ fs, lockPath, temporary, observed: existing }).pipe(
            Effect.ensuring(
              fs
                .remove(temporary, { force: true })
                .pipe(Effect.catchTag("PlatformError", () => Effect.void)),
            ),
          );
          return { held, token };
        });
        return yield* install.pipe(
          Effect.onExit((exit) => (Exit.isFailure(exit) ? held.close : Effect.void)),
        );
      }),
    ).pipe(
      Effect.mapError((error) =>
        Predicate.isTagged(error, "LeaseSlotTaken") ? new RegistryBusyError() : error,
      ),
      Effect.retry({
        while: (error) => Predicate.isTagged(error, "RegistryBusyError"),
        // Registry transactions include port leasing and atomic state writes; allow a few
        // seconds for a concurrent owner to finish before failing closed.
        schedule: Schedule.spaced("25 millis").pipe(Schedule.upTo({ times: 80 })),
      }),
      Effect.mapError((error) =>
        Predicate.isTagged(error, "RegistryBusyError")
          ? stateError("Stack registry is busy")
          : error,
      ),
    );
    return yield* Effect.acquireUseRelease(
      acquire,
      () => action,
      ({ held, token }) => removeLeaseIfHeld(fs, lockPath, token).pipe(Effect.andThen(held.close)),
    );
  });

export const makeStackStateStore = (options: {
  readonly stateRoot: string;
}): Effect.Effect<StackStateStore, never, FileSystem.FileSystem | Path.Path | Crypto.Crypto> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;

    const pathsFor = (stackId: string) =>
      Effect.gen(function* () {
        const valid = yield* validateId(stackId);
        return yield* resolveStackPaths({ stateRoot: options.stateRoot, stackId: valid }).pipe(
          Effect.mapError((error) =>
            error instanceof InvalidProjectRootError
              ? error
              : stateError(`Unable to resolve stack state paths: ${String(error)}`),
          ),
        );
      });

    const read = (
      stackId: string,
    ): Effect.Effect<
      PersistedStackState | undefined,
      InvalidProjectRootError | StackStateInvalidError | StackStateFormatUnsupportedError,
      FileSystem.FileSystem | Path.Path | Crypto.Crypto
    > =>
      Effect.gen(function* () {
        const paths = yield* pathsFor(stackId);
        const exists = yield* fs
          .exists(paths.stateDocument)
          .pipe(
            Effect.mapError((error) =>
              stateError(`Unable to inspect state document: ${error.message}`),
            ),
          );
        if (!exists) {
          const rootExists = yield* fs
            .exists(paths.stackRoot)
            .pipe(
              Effect.mapError((error) =>
                stateError(`Unable to inspect stack root: ${error.message}`),
              ),
            );
          if (!rootExists) return undefined;
          const entries = yield* fs
            .readDirectory(paths.stackRoot)
            .pipe(
              Effect.mapError((error) =>
                stateError(`Unable to inspect stack remnants: ${error.message}`),
              ),
            );
          if (entries.length > 0) {
            return yield* stateError(
              "Stack state is missing beside identity-owned remnants; refusing to guess replacement state",
            );
          }
          return undefined;
        }
        const info = yield* fs
          .stat(paths.stateDocument)
          .pipe(
            Effect.mapError((error) =>
              stateError(`Unable to inspect state document: ${error.message}`),
            ),
          );
        if (info.type !== "File")
          return yield* stateError("Stack state document is not a regular file");
        const text = yield* fs
          .readFileString(paths.stateDocument)
          .pipe(
            Effect.mapError((error) =>
              stateError(`Unable to read state document: ${error.message}`),
            ),
          );
        const raw = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
          Effect.mapError((error) =>
            stateError(`Unable to parse state document: ${String(error)}`),
          ),
        );
        const decoded = yield* decodeState(raw);
        yield* validateIdentityForStackId(decoded.identity, stackId);
        return decoded;
      });

    const initialize = (
      stackId: string,
      candidate: PersistedStackState,
    ): Effect.Effect<
      PersistedStackState,
      InvalidProjectRootError | StackStateInvalidError | StackStateFormatUnsupportedError,
      FileSystem.FileSystem | Path.Path | Crypto.Crypto
    > =>
      withRegistryLock(
        options.stateRoot,
        Effect.gen(function* () {
          const existing = yield* read(stackId);
          if (existing !== undefined) return existing;
          const paths = yield* pathsFor(stackId);
          yield* validateState(stackId, candidate);
          yield* persistValidatedState(fs, path, crypto, paths, candidate);
          return candidate;
        }),
      );

    const replaceUnlocked = (
      stackId: string,
      next: PersistedStackState,
    ): Effect.Effect<
      void,
      InvalidProjectRootError | StackStateInvalidError | StackStateFormatUnsupportedError,
      FileSystem.FileSystem | Path.Path | Crypto.Crypto
    > =>
      Effect.gen(function* () {
        const paths = yield* pathsFor(stackId);
        yield* validateIdentityForStackId(next.identity, stackId);
        const current = yield* read(stackId);
        if (current === undefined) return yield* stateError("Cannot replace missing stack state");
        yield* validateStateSchema(next);
        yield* persistValidatedState(fs, path, crypto, paths, next);
      });

    const replace = (
      stackId: string,
      next: PersistedStackState,
    ): Effect.Effect<
      void,
      InvalidProjectRootError | StackStateInvalidError | StackStateFormatUnsupportedError,
      FileSystem.FileSystem | Path.Path | Crypto.Crypto
    > => withRegistryLock(options.stateRoot, replaceUnlocked(stackId, next));

    const cleanup = (
      stackId: string,
    ): Effect.Effect<
      void,
      InvalidProjectRootError | StackStateInvalidError,
      FileSystem.FileSystem | Path.Path
    > =>
      withRegistryLock(
        options.stateRoot,
        Effect.gen(function* () {
          const paths = yield* pathsFor(stackId);
          yield* fs
            .remove(paths.stackRoot, { recursive: true, force: true })
            .pipe(
              Effect.mapError((error) =>
                stateError(`Unable to remove exact stack identity: ${error.message}`),
              ),
            );
        }),
      );

    return { read, initialize, replace, replaceUnlocked, cleanup } satisfies StackStateStore;
  });

export { PersistedStackStateSchema } from "./StackState.ts";
export type { PersistedStackState } from "./StackState.ts";
