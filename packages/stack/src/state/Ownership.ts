import { Context, Effect, FileSystem, Option, Path, Predicate, Schema, Scope } from "effect";
import { StackIdSchema, type StackId } from "../public/StackId.ts";
import { resolveStackPaths } from "./Paths.ts";
import { StackOwnershipConflictError, StackStateInvalidError } from "../public/Errors.ts";
import { OwnerSessionIdSchema } from "../control/MaintenanceProtocol.ts";

/** The owner metadata format is deliberately fail-closed. */
export const OWNERSHIP_FORMAT = "supabase-stack-owner-v1" as const;

export interface UnixControlEndpoint {
  readonly kind: "unix";
  readonly path: string;
}

export interface WindowsControlEndpoint {
  readonly kind: "pipe";
  readonly name: string;
}

export type ControlEndpoint = UnixControlEndpoint | WindowsControlEndpoint;

/** Host details are supplied by the process composition boundary. */
export interface StackRuntimeEnvironmentValue {
  readonly stateRoot: string;
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

export const ControlEndpointSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unix"), path: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("pipe"), name: Schema.String }),
]);

export const OwnerMetadataSchema = Schema.Struct({
  format: Schema.Literal(OWNERSHIP_FORMAT),
  stackId: StackIdSchema,
  ownerSessionId: OwnerSessionIdSchema,
  endpoint: ControlEndpointSchema,
  rpcRelease: Schema.String,
});
export type OwnerMetadata = Schema.Schema.Type<typeof OwnerMetadataSchema>;

export interface OwnerLease {
  readonly metadata: OwnerMetadata;
  readonly lockPath: string;
  readonly metadataPath: string;
  /** Releases only this session's exact metadata and O_EXCL lock. */
  readonly release: Effect.Effect<void>;
}

const stateError = (message: string) => new StackStateInvalidError({ message });

const decodeStackId = (value: string): Effect.Effect<StackId, StackStateInvalidError> =>
  Schema.decodeEffect(StackIdSchema)(value).pipe(
    Effect.mapError((error) => stateError(`Invalid StackId: ${String(error)}`)),
  );

const metadataFrom = (value: unknown): Effect.Effect<OwnerMetadata, StackStateInvalidError> =>
  Schema.decodeUnknownEffect(OwnerMetadataSchema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError((error) => stateError(`Invalid owner metadata: ${String(error)}`)),
  );

const endpointPath = (endpoint: ControlEndpoint): string =>
  endpoint.kind === "unix" ? endpoint.path : endpoint.name;

/**
 * Computes the one local endpoint for an identity. The complete digest is used
 * so two identities can never alias. The caller supplies a deliberately short
 * IPC root; no project path is embedded in the endpoint.
 */
export const controlEndpointFor = (
  stackId: StackId | string,
  environment: Pick<StackRuntimeEnvironmentValue, "platform" | "tempRoot">,
): ControlEndpoint => {
  const root = environment.tempRoot.replace(/[\\/]+$/, "");
  const token = String(stackId);
  if (environment.platform === "windows")
    return { kind: "pipe", name: `\\\\.\\pipe\\supabase-stack-${token}` };
  return { kind: "unix", path: `${root}/supabase-stack-${token}.sock` };
};

export const ownerMetadataPath = (paths: { readonly controlMetadata: string }): string =>
  paths.controlMetadata;

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
    const expected = controlEndpointFor(validId, environment);
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

const removeLockIfOwned = (
  fs: FileSystem.FileSystem,
  lockPath: string,
  ownerSessionId: string,
): Effect.Effect<void> =>
  fs.readFileString(lockPath).pipe(
    Effect.flatMap((owner) =>
      owner === ownerSessionId ? fs.remove(lockPath, { force: true }) : Effect.void,
    ),
    Effect.catchTag("PlatformError", () => Effect.void),
  );

/** Acquires the sole O_EXCL ownership proof. Existing locks are never stolen. */
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
    const metadata: OwnerMetadata = {
      format: OWNERSHIP_FORMAT,
      stackId: validId,
      ownerSessionId: options.ownerSessionId,
      endpoint: controlEndpointFor(validId, options.environment),
      rpcRelease: options.rpcRelease,
    };
    const release = Effect.suspend(() => {
      return fs.readFileString(paths.controlMetadata).pipe(
        Effect.flatMap((text) =>
          Schema.decodeEffect(Schema.fromJsonString(OwnerMetadataSchema))(text).pipe(
            Effect.flatMap((current) =>
              current.stackId === validId && current.ownerSessionId === options.ownerSessionId
                ? fs.remove(paths.controlMetadata, { force: true }).pipe(
                    Effect.catchTag("PlatformError", () => Effect.void),
                    Effect.andThen(removeLockIfOwned(fs, lockPath, options.ownerSessionId)),
                  )
                : Effect.void,
            ),
          ),
        ),
        // Missing metadata means acquisition failed before publication; the
        // lock still belongs to this random session and may be removed.
        Effect.catchTag("PlatformError", () =>
          removeLockIfOwned(fs, lockPath, options.ownerSessionId),
        ),
        // Malformed metadata is fail-closed: an old finalizer must not remove
        // a lock that could now belong to another owner.
        Effect.ignore,
      );
    });
    const lease = {
      metadata,
      lockPath,
      metadataPath: paths.controlMetadata,
      release,
    } satisfies OwnerLease;
    const scope = yield* Scope.Scope;
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* restore(fs.makeDirectory(paths.runtime, { recursive: true, mode: 0o700 })).pipe(
          Effect.mapError((error) =>
            stateError(`Unable to create owner directory: ${error.message}`),
          ),
        );
        yield* restore(
          fs.writeFileString(lockPath, options.ownerSessionId, { flag: "wx", mode: 0o600 }),
        ).pipe(
          Effect.mapError((error) =>
            Predicate.isTagged(error.reason, "AlreadyExists")
              ? new StackOwnershipConflictError({
                  message: "A Supervisor already owns this stack",
                  stackId: validId,
                })
              : stateError(`Unable to acquire owner lock: ${error.message}`),
          ),
        );
        yield* Scope.addFinalizer(scope, release);
        return lease;
      }),
    );
  });

export { endpointPath };
