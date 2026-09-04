import {
  Context,
  Data,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Predicate,
  Schema,
  Scope,
} from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer, type Server } from "node:net";
import { StackIdSchema, type StackId } from "../public/StackId.ts";
import { resolveStackPaths } from "./Paths.ts";
import { StackOwnershipConflictError, StackStateInvalidError } from "../public/Errors.ts";
import { OwnerSessionIdSchema } from "../control/MaintenanceProtocol.ts";
import { NetworkPortSchema } from "../public/Status.ts";

/** The owner metadata format is deliberately fail-closed. */
const OWNERSHIP_FORMAT = "supabase-stack-owner-v1" as const;
export const OWNER_LOCK_FORMAT = "supabase-stack-lease-v1" as const;

interface UnixControlEndpoint {
  readonly kind: "unix";
  readonly path: string;
}

interface WindowsControlEndpoint {
  readonly kind: "pipe";
  readonly name: string;
}

export type ControlEndpoint = UnixControlEndpoint | WindowsControlEndpoint;

/** Host details are supplied by the process composition boundary. */
export interface StackRuntimeEnvironmentValue {
  readonly stateRoot: string;
  /** Optional shared immutable artifact cache; defaults to `<stateRoot>/artifacts`. */
  readonly artifactCacheRoot?: string;
  /** A short local IPC directory (for example `/tmp`). */
  readonly tempRoot: string;
  readonly platform: "posix" | "windows";
  readonly supervisorCommand?: string;
  readonly supervisorEntrypoint?: string;
}

export class StackRuntimeEnvironment extends Context.Service<
  StackRuntimeEnvironment,
  StackRuntimeEnvironmentValue
>()("@supabase/stack/StackRuntimeEnvironment") {}

const ControlEndpointSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unix"), path: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("pipe"), name: Schema.String }),
]);

const OwnerMetadataSchema = Schema.Struct({
  format: Schema.Literal(OWNERSHIP_FORMAT),
  stackId: StackIdSchema,
  ownerSessionId: OwnerSessionIdSchema,
  leasePort: NetworkPortSchema,
  endpoint: ControlEndpointSchema,
  rpcRelease: Schema.String,
});
export type OwnerMetadata = Schema.Schema.Type<typeof OwnerMetadataSchema>;

const OwnerLockSchema = Schema.Struct({
  format: Schema.Literal(OWNER_LOCK_FORMAT),
  token: Schema.String,
  port: NetworkPortSchema,
});
export type OwnerLock = Schema.Schema.Type<typeof OwnerLockSchema>;
export class LeaseSlotTaken extends Data.TaggedError("LeaseSlotTaken")<{}> {}

export interface OwnerLease {
  readonly metadata: OwnerMetadata;
  readonly lockPath: string;
  readonly metadataPath: string;
  /** Releases only this session's exact metadata and atomic owner lock. */
  readonly release: Effect.Effect<void>;
}

const ownerLockFrom = (value: unknown): Effect.Effect<OwnerLock, StackStateInvalidError> =>
  Schema.decodeUnknownEffect(OwnerLockSchema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError((error) => stateError(`Invalid owner lock: ${String(error)}`)),
    Effect.flatMap((lock) =>
      lock.token.length > 0
        ? Effect.succeed(lock)
        : Effect.fail(stateError("Invalid owner lock lease")),
    ),
  );

export const readOwnerLock = (
  fs: FileSystem.FileSystem,
  lockPath: string,
): Effect.Effect<OwnerLock | undefined, StackStateInvalidError> =>
  fs.readFileString(lockPath).pipe(
    Effect.flatMap((text) =>
      Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
        Effect.mapError((error) => stateError(`Unable to parse owner lock: ${String(error)}`)),
        Effect.flatMap(ownerLockFrom),
      ),
    ),
    Effect.catchTag("PlatformError", (error) =>
      Predicate.isTagged(error.reason, "NotFound")
        ? // oxlint-disable-next-line effecttsgo/effect-succeed-with-void -- this branch carries Option.none as undefined
          Effect.succeed(undefined)
        : Effect.fail(stateError(`Unable to read owner lock: ${error.message}`)),
    ),
  );

const bindLease = (port: number): Effect.Effect<Server, StackStateInvalidError> =>
  Effect.callback<Server, StackStateInvalidError>((resume) => {
    const server = createServer({ allowHalfOpen: false }, (socket) => socket.destroy());
    let settled = false;
    let canceled = false;
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const close = () => {
      if (server.listening) {
        try {
          server.close(() => undefined);
        } catch {
          // The listener may have failed before a handle was allocated.
        }
      }
    };
    const onError = (cause: Error & { readonly code?: string }) => {
      if (settled) return;
      settled = true;
      cleanup();
      close();
      if (canceled) return;
      resume(
        Effect.fail(
          new StackStateInvalidError({
            message: `Unable to acquire owner lease: ${cause.message}`,
            code: cause.code,
            cause,
          }),
        ),
      );
    };
    const onListening = () => {
      if (canceled) {
        settled = true;
        cleanup();
        close();
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      resume(Effect.succeed(server));
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen({ host: "127.0.0.1", port });
    } catch (cause) {
      onError(cause instanceof Error ? cause : new Error(String(cause)));
    }
    return Effect.sync(() => {
      if (!settled) {
        canceled = true;
        if (server.listening) close();
      }
    });
  });

const closeBoundServer = (server: Server): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (!server.listening) {
      resume(Effect.void);
      return;
    }
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resume(Effect.void);
      }
    };
    try {
      server.close(finish);
    } catch {
      finish();
    }
    return Effect.sync(() => {
      if (!settled) {
        settled = true;
        try {
          server.close(() => undefined);
        } catch {
          // The exact listener is already closed or was never allocated.
        }
      }
    });
  });

const leasePort = (server: Server): Effect.Effect<number, StackStateInvalidError> =>
  Effect.sync(() => {
    const address = server.address();
    if (address === null || typeof address === "string" || !Number.isInteger(address.port))
      return undefined;
    return address.port;
  }).pipe(
    Effect.flatMap((port) =>
      port === undefined
        ? Effect.fail(stateError("Owner lease did not expose a bound port"))
        : Effect.succeed(port),
    ),
  );

export interface HeldPortLease {
  readonly port: number;
  readonly close: Effect.Effect<void>;
}

export const acquirePortLease = (
  port: number,
): Effect.Effect<HeldPortLease, StackStateInvalidError> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const server = yield* bindLease(port);
      return yield* leasePort(server).pipe(
        Effect.map((actualPort) => ({ port: actualPort, close: closeBoundServer(server) })),
        Effect.onExit((exit) => (Exit.isFailure(exit) ? closeBoundServer(server) : Effect.void)),
      );
    }),
  );

const stateError = (message: string) => new StackStateInvalidError({ message });

const decodeStackId = (value: string): Effect.Effect<StackId, StackStateInvalidError> =>
  Schema.decodeEffect(StackIdSchema)(value).pipe(
    Effect.mapError((error) => stateError(`Invalid StackId: ${String(error)}`)),
  );

const metadataFrom = (value: unknown): Effect.Effect<OwnerMetadata, StackStateInvalidError> =>
  Schema.decodeUnknownEffect(OwnerMetadataSchema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError((error) => stateError(`Invalid owner metadata: ${String(error)}`)),
  );

/**
 * Computes the one local endpoint for an identity. The complete digest is used
 * so two identities can never alias. The caller supplies a deliberately short
 * IPC root; no project path is embedded in the endpoint.
 */
export const controlEndpointFor = (
  stackId: StackId | string,
  environment: Pick<StackRuntimeEnvironmentValue, "platform" | "tempRoot">,
  leasePort: number,
): ControlEndpoint => {
  const root = environment.tempRoot.replace(/[\\/]+$/, "");
  const token = String(stackId);
  if (environment.platform === "windows")
    return { kind: "pipe", name: `\\\\.\\pipe\\supabase-stack-${token}-${leasePort}` };
  return { kind: "unix", path: `${root}/supabase-stack-${token}-${leasePort}.sock` };
};

/** Reads and validates complete owner metadata without probing or mutating. */
export const readOwnerMetadata = (
  stateRoot: string,
  stackId: StackId | string,
  environment: Pick<StackRuntimeEnvironmentValue, "platform" | "tempRoot">,
): Effect.Effect<
  OwnerMetadata | undefined,
  StackStateInvalidError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const validId = yield* decodeStackId(String(stackId));
    const paths = yield* resolveStackPaths({ stateRoot, stackId: validId }).pipe(
      Effect.mapError((error) => stateError(String(error))),
    );
    const exists = yield* fs
      .exists(paths.controlMetadata)
      .pipe(
        Effect.mapError((error) =>
          stateError(`Unable to inspect owner metadata: ${error.message}`),
        ),
      );
    if (!exists) return undefined;
    const raw = yield* fs.readFileString(paths.controlMetadata).pipe(
      Effect.map(Option.some),
      Effect.catchTag("PlatformError", (error) =>
        Predicate.isTagged(error.reason, "NotFound")
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(stateError(`Unable to read owner metadata: ${error.message}`)),
      ),
    );
    if (Option.isNone(raw)) return undefined;
    const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
      raw.value,
    ).pipe(
      Effect.mapError((error) => stateError(`Unable to parse owner metadata: ${String(error)}`)),
    );
    const metadata = yield* metadataFrom(parsed);
    if (metadata.stackId !== validId)
      return yield* stateError("Owner metadata StackId does not match its directory");
    const expected = controlEndpointFor(validId, environment, metadata.leasePort);
    if (metadata.endpoint.kind !== expected.kind)
      return yield* stateError("Owner metadata endpoint kind does not match this runtime");
    if (
      metadata.endpoint.kind === "unix" &&
      expected.kind === "unix" &&
      metadata.endpoint.path !== expected.path
    )
      return yield* stateError("Owner metadata endpoint does not match its StackId");
    if (
      metadata.endpoint.kind === "pipe" &&
      expected.kind === "pipe" &&
      metadata.endpoint.name !== expected.name
    )
      return yield* stateError("Owner metadata endpoint does not match its StackId");
    return metadata;
  });

export const ownerLockExists = (
  stateRoot: string,
  stackId: StackId | string,
): Effect.Effect<boolean, StackStateInvalidError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const validId = yield* decodeStackId(String(stackId));
    const paths = yield* resolveStackPaths({ stateRoot, stackId: validId }).pipe(
      Effect.mapError((error) => stateError(String(error))),
    );
    return yield* fs
      .exists(path.join(paths.runtime, "owner.lock"))
      .pipe(
        Effect.mapError((error) => stateError(`Unable to inspect owner lock: ${error.message}`)),
      );
  });

/**
 * Publishes metadata through a sibling temporary file and same-directory
 * rename. Readers therefore observe either no document or one complete JSON
 * document, never a partially written owner record.
 */
export const publishOwnership = (
  lease: OwnerLease,
): Effect.Effect<void, StackStateInvalidError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(OwnerMetadataSchema))(
      lease.metadata,
    ).pipe(
      Effect.mapError((error) => stateError(`Unable to encode owner metadata: ${String(error)}`)),
    );
    const temporary = `${lease.metadataPath}.${lease.metadata.ownerSessionId}.tmp`;
    const existing = yield* fs
      .exists(lease.metadataPath)
      .pipe(
        Effect.mapError((error) =>
          stateError(`Unable to inspect existing owner metadata: ${error.message}`),
        ),
      );
    if (existing)
      return yield* stateError("Owner metadata already exists; explicit recovery is required");
    const publish = Effect.gen(function* () {
      yield* fs
        .remove(temporary, { force: true })
        .pipe(Effect.catchTag("PlatformError", () => Effect.void));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs
            .open(temporary, { flag: "wx", mode: 0o600 })
            .pipe(
              Effect.mapError((error) =>
                stateError(`Unable to open owner metadata: ${error.message}`),
              ),
            );
          yield* file
            .writeAll(new TextEncoder().encode(encoded))
            .pipe(
              Effect.mapError((error) =>
                stateError(`Unable to write owner metadata: ${error.message}`),
              ),
            );
          yield* file.sync.pipe(
            Effect.mapError((error) =>
              stateError(`Unable to sync owner metadata: ${error.message}`),
            ),
          );
        }),
      );
      yield* fs
        .rename(temporary, lease.metadataPath)
        .pipe(
          Effect.mapError((error) =>
            stateError(`Unable to publish owner metadata: ${error.message}`),
          ),
        );
      yield* fs
        .chmod(lease.metadataPath, 0o600)
        .pipe(
          Effect.mapError((error) =>
            stateError(`Unable to secure owner metadata: ${error.message}`),
          ),
        );
    });
    yield* publish.pipe(
      Effect.ensuring(
        fs
          .remove(temporary, { force: true })
          .pipe(Effect.catchTag("PlatformError", () => Effect.void)),
      ),
    );
  });

export const removeLeaseIfHeld = (
  fs: FileSystem.FileSystem,
  lockPath: string,
  token: string,
): Effect.Effect<void> =>
  readOwnerLock(fs, lockPath).pipe(
    Effect.flatMap((owner) =>
      owner?.token === token ? fs.remove(lockPath, { force: true }) : Effect.void,
    ),
    Effect.catchTags({
      PlatformError: () => Effect.void,
      StackStateInvalidError: () => Effect.void,
    }),
  );

export const writeLockTemp = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  lockPath: string,
  lock: OwnerLock,
): Effect.Effect<string, StackStateInvalidError> =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(OwnerLockSchema))(lock).pipe(
      Effect.mapError((error) => stateError(`Unable to encode owner lock: ${String(error)}`)),
    );
    const temporary = path.join(path.dirname(lockPath), `.owner.${lock.token}.tmp`);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs
          .open(temporary, { flag: "wx", mode: 0o600 })
          .pipe(
            Effect.mapError((error) => stateError(`Unable to open owner lock: ${error.message}`)),
          );
        yield* file
          .writeAll(new TextEncoder().encode(encoded))
          .pipe(
            Effect.mapError((error) => stateError(`Unable to write owner lock: ${error.message}`)),
          );
        yield* file.sync.pipe(
          Effect.mapError((error) => stateError(`Unable to sync owner lock: ${error.message}`)),
        );
      }),
    );
    return temporary;
  }).pipe(
    Effect.onExit((exit) =>
      Exit.isFailure(exit)
        ? fs
            .remove(path.join(path.dirname(lockPath), `.owner.${lock.token}.tmp`), { force: true })
            .pipe(Effect.catchTag("PlatformError", () => Effect.void))
        : Effect.void,
    ),
  );

export const installLease = (options: {
  readonly fs: FileSystem.FileSystem;
  readonly lockPath: string;
  readonly temporary: string;
  readonly observed: OwnerLock | undefined;
}): Effect.Effect<void, StackStateInvalidError | LeaseSlotTaken> =>
  Effect.gen(function* () {
    if (options.observed !== undefined) {
      yield* verifyObservedLease(options.fs, options.lockPath, options.observed);
      yield* options.fs
        .remove(options.lockPath, { force: false })
        .pipe(
          Effect.mapError((error) =>
            Predicate.isTagged(error.reason, "NotFound")
              ? new LeaseSlotTaken()
              : stateError(`Unable to remove stale owner lock: ${error.message}`),
          ),
        );
    }
    yield* options.fs
      .link(options.temporary, options.lockPath)
      .pipe(
        Effect.mapError((error) =>
          Predicate.isTagged(error.reason, "AlreadyExists")
            ? new LeaseSlotTaken()
            : stateError(`Unable to publish owner lock: ${error.message}`),
        ),
      );
  });

/** Revalidates the exact stale record immediately before destructive recovery. */
export const verifyObservedLease = (
  fs: FileSystem.FileSystem,
  lockPath: string,
  observed: OwnerLock,
): Effect.Effect<void, StackStateInvalidError | LeaseSlotTaken> =>
  readOwnerLock(fs, lockPath).pipe(
    Effect.flatMap((current) =>
      current !== undefined &&
      current.format === observed.format &&
      current.token === observed.token &&
      current.port === observed.port
        ? Effect.void
        : Effect.fail(new LeaseSlotTaken()),
    ),
  );

/**
 * Acquires an OS-held loopback lease. The canonical lock is atomically installed
 * by hard-linking a uniquely created temporary record, and the listener remains bound for the
 * lifetime of the lease. A valid lock is reclaimable only when its recorded
 * port can be bound again.
 */
export const acquireOwnership = (options: {
  readonly stateRoot: string;
  readonly stackId: StackId | string;
  readonly ownerSessionId: string;
  readonly rpcRelease: string;
  readonly environment: Pick<StackRuntimeEnvironmentValue, "platform" | "tempRoot">;
}): Effect.Effect<
  OwnerLease,
  StackOwnershipConflictError | StackStateInvalidError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const validId = yield* decodeStackId(String(options.stackId));
    const path = yield* Path.Path;
    const paths = yield* resolveStackPaths({ stateRoot: options.stateRoot, stackId: validId }).pipe(
      Effect.mapError((error) => stateError(String(error))),
    );
    const lockPath = path.join(paths.runtime, "owner.lock");
    const scope = yield* Scope.Scope;
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* restore(fs.makeDirectory(paths.runtime, { recursive: true, mode: 0o700 })).pipe(
          Effect.mapError((error) =>
            stateError(`Unable to create owner directory: ${error.message}`),
          ),
        );

        const existing = yield* readOwnerLock(fs, lockPath);
        const metadataExists = yield* fs
          .exists(paths.controlMetadata)
          .pipe(
            Effect.mapError((error) =>
              stateError(`Unable to inspect stale owner metadata: ${error.message}`),
            ),
          );
        if (existing === undefined && metadataExists)
          return yield* new StackOwnershipConflictError({
            message: "Owner metadata exists without a lease lock; refusing recovery",
            stackId: validId,
          });
        const held = yield* acquirePortLease(existing?.port ?? 0).pipe(
          Effect.mapError((error) =>
            existing !== undefined && error["code"] === "EADDRINUSE"
              ? new StackOwnershipConflictError({
                  message: "A Supervisor already owns this stack",
                  stackId: validId,
                })
              : error,
          ),
        );
        const metadata: OwnerMetadata = {
          format: OWNERSHIP_FORMAT,
          stackId: validId,
          ownerSessionId: options.ownerSessionId,
          leasePort: held.port,
          endpoint: controlEndpointFor(validId, options.environment, held.port),
          rpcRelease: options.rpcRelease,
        };
        const acquire = Effect.gen(function* () {
          const port = held.port;
          const lock: OwnerLock = {
            format: OWNER_LOCK_FORMAT,
            token: options.ownerSessionId,
            port,
          };
          const temporary = yield* writeLockTemp(fs, path, lockPath, lock);
          const installed = Effect.gen(function* () {
            // Revalidate the exact observed stale record before deleting any
            // metadata or socket. This closes the recovery crash window.
            if (existing !== undefined)
              yield* verifyObservedLease(fs, lockPath, existing).pipe(
                Effect.mapError((error) =>
                  Predicate.isTagged(error, "LeaseSlotTaken")
                    ? new StackOwnershipConflictError({
                        message: "A Supervisor already owns this stack",
                        stackId: validId,
                      })
                    : error,
                ),
              );
            // The old control document can only be removed after the stale
            // lease has been revalidated; the canonical lock remains until install.
            if (existing !== undefined) {
              yield* fs
                .remove(paths.controlMetadata, { force: true })
                .pipe(Effect.catchTag("PlatformError", () => Effect.void));
            }
            yield* installLease({
              fs,
              lockPath,
              temporary,
              observed: existing,
            }).pipe(
              Effect.mapError((error) =>
                Predicate.isTagged(error, "LeaseSlotTaken")
                  ? new StackOwnershipConflictError({
                      message: "A Supervisor already owns this stack",
                      stackId: validId,
                    })
                  : error,
              ),
            );
            // Only the process that atomically installed the canonical lock has
            // lease authority to remove a stale Unix control socket. A loser
            // must not unlink the winner's newly bound endpoint.
            if (options.environment.platform === "posix" && metadata.endpoint.kind === "unix")
              yield* fs
                .remove(metadata.endpoint.path, { force: true })
                .pipe(Effect.catchTag("PlatformError", () => Effect.void));
          });
          yield* installed.pipe(
            Effect.ensuring(
              fs
                .remove(temporary, { force: true })
                .pipe(Effect.catchTag("PlatformError", () => Effect.void)),
            ),
          );
          const release = Effect.suspend(() =>
            fs.readFileString(paths.controlMetadata).pipe(
              Effect.flatMap((text) =>
                Schema.decodeEffect(Schema.fromJsonString(OwnerMetadataSchema))(text).pipe(
                  Effect.flatMap((current) =>
                    current.stackId === validId && current.ownerSessionId === options.ownerSessionId
                      ? fs.remove(paths.controlMetadata, { force: true }).pipe(
                          Effect.catchTag("PlatformError", () => Effect.void),
                          Effect.andThen(removeLeaseIfHeld(fs, lockPath, options.ownerSessionId)),
                        )
                      : Effect.void,
                  ),
                ),
              ),
              Effect.catchTag("PlatformError", () =>
                removeLeaseIfHeld(fs, lockPath, options.ownerSessionId),
              ),
              Effect.ignore,
              Effect.andThen(held.close),
            ),
          );
          const lease = {
            metadata,
            lockPath,
            metadataPath: paths.controlMetadata,
            release,
          } satisfies OwnerLease;
          yield* Scope.addFinalizer(scope, Effect.uninterruptible(release));
          return lease;
        });
        return yield* acquire.pipe(
          Effect.onExit((exit) => (Exit.isFailure(exit) ? held.close : Effect.void)),
        );
      }),
    );
  });
