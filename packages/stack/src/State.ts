import {
  Data,
  Duration,
  Effect,
  FileSystem,
  Context,
  Layer,
  Path,
  Predicate,
  Schedule,
  Schema,
} from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem has no non-recursive directory removal operation.
import { rmdir } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem has no OS-owned cross-process lock primitive.
import { DatabaseSync } from "node:sqlite";
import { CompositionConfig } from "./Orchestrator.ts";
import { restrictDirectoryToOwner } from "./runtime/postgres-user.ts";
import { ServiceCreation } from "./services/Catalog.ts";

const SafeId = Schema.String.pipe(
  Schema.refine((value): value is string => /^[a-zA-Z0-9_-]+$/u.test(value), {
    identifier: "SafeStateId",
    message: "Expected a safe state id",
  }),
);

const SavedInstance = Schema.Struct({
  id: SafeId,
  creation: Schema.toCodecJson(ServiceCreation),
});
interface SavedInstance extends Schema.Schema.Type<typeof SavedInstance> {}

export const StackIdentityInput = Schema.Struct({
  publishableKey: Schema.optionalKey(Schema.String),
  secretKey: Schema.optionalKey(Schema.String),
  anonKey: Schema.optionalKey(Schema.String),
  anonKeyIsOverride: Schema.optionalKey(Schema.Boolean),
  serviceRoleKey: Schema.optionalKey(Schema.String),
  serviceRoleKeyIsOverride: Schema.optionalKey(Schema.Boolean),
  gotrueJwtKeys: Schema.optionalKey(Schema.String),
  publicSigningKeys: Schema.optionalKey(Schema.String),
  remoteJwks: Schema.optionalKey(Schema.String),
});
export interface StackIdentityInput extends Schema.Schema.Type<typeof StackIdentityInput> {}

export const StackCredentials = Schema.Struct({
  jwtSecret: Schema.String,
  postgresRootKey: Schema.String,
  databasePassword: Schema.String,
  publishableKey: Schema.String,
  secretKey: Schema.String,
  anonKey: Schema.String,
  serviceRoleKey: Schema.String,
  jwks: Schema.String,
  gotrueJwtKeys: Schema.String,
  remoteJwks: Schema.String,
  anonKeyIsOverride: Schema.Boolean,
  serviceRoleKeyIsOverride: Schema.Boolean,
});
export interface StackCredentials extends Schema.Schema.Type<typeof StackCredentials> {}

const PortClaim = Schema.Struct({
  key: Schema.String,
  host: Schema.String,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
});
export interface PortClaim extends Schema.Schema.Type<typeof PortClaim> {}

export const SavedStack = Schema.Struct({
  id: SafeId,
  identity: Schema.Struct({
    projectRoot: Schema.String,
    branchContext: Schema.String,
    stackName: Schema.String,
  }),
  runtime: Schema.Literals(["native", "docker", "podman"]),
  instances: Schema.Array(SavedInstance).check(
    Schema.makeFilter((instances) =>
      new Set(instances.map(({ id }) => id)).size === instances.length
        ? undefined
        : "Expected unique instance ids",
    ),
  ),
  composition: CompositionConfig,
  credentials: Schema.optionalKey(StackCredentials),
  ports: Schema.Array(PortClaim),
});
export interface SavedStack extends Schema.Schema.Type<typeof SavedStack> {}

const ClaimsDocument = Schema.Struct({ ports: Schema.Array(PortClaim) });

export interface StackClaims {
  readonly id: string;
  readonly ports: ReadonlyArray<PortClaim>;
}

export class StateError extends Data.TaggedError("StateError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface Interface {
  readonly read: (id: string) => Effect.Effect<SavedStack | undefined, StateError>;
  /** Skips each stack entry that stays unreadable after transient retries, reporting it to `onInvalidState`. */
  readonly list: Effect.Effect<ReadonlyArray<SavedStack>, StateError>;
  /** Decodes only each stack's port claims and silently skips entries that cannot provide them. */
  readonly claims: Effect.Effect<ReadonlyArray<StackClaims>, StateError>;
  readonly save: (state: SavedStack) => Effect.Effect<void, StateError>;
  readonly remove: (id: string) => Effect.Effect<void, StateError>;
  /** Not reentrant; wrap metadata updates here, while Ports operations acquire this lock themselves. */
  readonly withLock: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StateError, R>;
}

export class Service extends Context.Service<Service, Interface>()("@supabase/stack/State") {}

const stateError = (operation: string, cause: unknown): StateError =>
  new StateError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const checkId = (id: string): Effect.Effect<void, StateError> =>
  Schema.is(SafeId)(id)
    ? Effect.void
    : Effect.fail(stateError("identity", `Invalid state id: ${id}`));

const decodeState = (
  text: string,
  id: string,
  target: string,
): Effect.Effect<SavedStack, StateError> =>
  Schema.decodeEffect(Schema.fromJsonString(SavedStack))(text).pipe(
    Effect.mapError(
      (cause) =>
        new StateError({
          operation: "decode",
          message: `Unable to decode state ${target} for stack ${id}: ${cause.message}`,
          cause,
        }),
    ),
  );

interface Options {
  readonly root: string;
  readonly platform?: NodeJS.Platform;
  readonly onInvalidState?: (id: string, error: StateError) => Effect.Effect<void>;
}

const makeState = (
  options: Options,
): Effect.Effect<Interface, StateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.normalize(options.root);
    // SQLite alone opens this persistent file; other descriptors can invalidate its POSIX locks.
    const lock = path.join(root, ".registry-lock.sqlite");
    yield* fs
      .makeDirectory(root, { recursive: true })
      .pipe(Effect.mapError((cause) => stateError("root", cause)));
    yield* restrictDirectoryToOwner(fs, root).pipe(
      Effect.mapError((cause) => stateError("root", cause)),
    );

    const stackRoot = (id: string) => path.join(root, id);
    const statePath = (id: string) => path.join(stackRoot(id), "state.json");
    const publishRetrySchedule = Schedule.exponential("10 millis", 2).pipe(
      Schedule.modifyDelay(({ duration }) =>
        Effect.succeed(Duration.min(duration, Duration.millis(100))),
      ),
      Schedule.upTo({ times: 12 }),
    );
    const errorCode = (error: unknown): string | undefined => {
      if (!Predicate.hasProperty(error, "cause")) return undefined;
      return Predicate.hasProperty(error.cause, "code") && typeof error.cause.code === "string"
        ? error.cause.code
        : undefined;
    };
    /** Windows reports a file that another process is replacing as a transient sharing violation. */
    const sharingViolation = (error: unknown) =>
      (options.platform ?? process.platform) === "win32" &&
      ["EPERM", "EACCES", "EBUSY"].includes(errorCode(error) ?? "");
    const retryTransientRead = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.retry({ schedule: publishRetrySchedule, while: sharingViolation }),
        Effect.mapError((cause) => stateError("read", cause)),
      );
    const publish = Effect.fn("State.publish")(function* (temporary: string, target: string) {
      yield* fs.rename(temporary, target).pipe(
        Effect.retry({ schedule: publishRetrySchedule, while: sharingViolation }),
        Effect.mapError(
          (cause) =>
            new StateError({
              operation: "publish",
              message: `Unable to publish state to ${target}${errorCode(cause) ? ` (${errorCode(cause)})` : ""}: ${cause instanceof Error ? cause.message : String(cause)}`,
              cause,
            }),
        ),
      );
    });
    const removeEmptyDirectory = (directory: string) =>
      Effect.tryPromise({
        try: () => rmdir(directory),
        catch: (cause) => stateError("cleanup", cause),
      }).pipe(
        Effect.catch((cause) => {
          const code =
            typeof cause.cause === "object" && cause.cause !== null && "code" in cause.cause
              ? cause.cause.code
              : undefined;
          return code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST"
            ? Effect.void
            : Effect.fail(cause);
        }),
      );
    const read = Effect.fn("State.read")(function* (id: string) {
      yield* checkId(id);
      const target = statePath(id);
      const exists = yield* fs.exists(target).pipe(retryTransientRead);
      if (!exists) return undefined;
      const text = yield* fs.readFileString(target).pipe(retryTransientRead);
      const state = yield* decodeState(text, id, target);
      if (state.id !== id) {
        return yield* stateError("identity", "State document identity does not match its path");
      }
      return state;
    });
    const stackIds = fs.readDirectory(root).pipe(
      Effect.map((entries) => entries.filter(Schema.is(SafeId))),
      Effect.mapError((cause) => stateError("list", cause)),
    );
    const readEntries = <A>(
      readEntry: (id: string) => Effect.Effect<A | undefined, StateError>,
      onSkipped: (id: string, error: StateError) => Effect.Effect<void>,
    ) =>
      Effect.gen(function* () {
        const entries: Array<A> = [];
        for (const id of yield* stackIds) {
          const value = yield* readEntry(id).pipe(
            Effect.catch((error) => onSkipped(id, error).pipe(Effect.as(undefined))),
          );
          if (value !== undefined) entries.push(value);
        }
        return entries;
      });
    const list = Effect.fn("State.list")(() =>
      readEntries(read, (id, error) => options.onInvalidState?.(id, error) ?? Effect.void),
    );
    const decodeClaims = Schema.decodeEffect(Schema.fromJsonString(ClaimsDocument));
    const readClaims = (id: string) =>
      fs.readFileString(statePath(id)).pipe(
        retryTransientRead,
        Effect.flatMap((text) =>
          decodeClaims(text).pipe(Effect.mapError((cause) => stateError("decode", cause))),
        ),
        Effect.map(({ ports }): StackClaims => ({ id, ports })),
      );
    const claims = Effect.fn("State.claims")(() => readEntries(readClaims, () => Effect.void));
    const save = Effect.fn("State.save")(function* (state: SavedStack) {
      yield* checkId(state.id);
      const target = statePath(state.id);
      const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(SavedStack))(state).pipe(
        Effect.mapError((cause) => stateError("encode", cause)),
      );
      yield* fs
        .makeDirectory(stackRoot(state.id), { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError((cause) => stateError("write", cause)));
      yield* Effect.acquireUseRelease(
        fs
          .makeTempDirectory({ directory: root, prefix: ".state-write-" })
          .pipe(Effect.mapError((cause) => stateError("write", cause))),
        (directory) =>
          Effect.gen(function* () {
            const temporary = path.join(directory, "state.json");
            yield* fs
              .writeFileString(temporary, serialized, { mode: 0o600 })
              .pipe(Effect.mapError((cause) => stateError("write", cause)));
            yield* publish(temporary, target);
          }),
        (directory) =>
          fs
            .remove(directory, { recursive: true, force: true })
            .pipe(Effect.mapError((cause) => stateError("cleanup", cause))),
      );
    });
    const remove = Effect.fn("State.remove")(function* (id: string) {
      yield* checkId(id);
      yield* fs
        .remove(statePath(id), { force: true })
        .pipe(Effect.mapError((cause) => stateError("remove", cause)));
      yield* removeEmptyDirectory(path.join(stackRoot(id), "data"));
      yield* removeEmptyDirectory(stackRoot(id));
    });
    const withLock = Effect.fn("State.withLock")(<A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.try({
          try: () => new DatabaseSync(lock),
          catch: (cause) => stateError("lock", cause),
        }),
        (connection) =>
          Effect.gen(function* () {
            yield* Effect.try({
              try: () => connection.exec("PRAGMA busy_timeout = 0"),
              catch: (cause) => stateError("lock", cause),
            });
            yield* Effect.try({
              try: () => connection.exec("BEGIN IMMEDIATE"),
              catch: (cause) => stateError("lock", cause),
            }).pipe(
              Effect.retry({
                schedule: Schedule.spaced("50 millis").pipe(
                  Schedule.upTo({ duration: "5 seconds" }),
                ),
                while: (error) =>
                  Predicate.hasProperty(error.cause, "errcode") && error.cause.errcode === 5,
              }),
              Effect.mapError((error) =>
                Predicate.hasProperty(error.cause, "errcode") && error.cause.errcode === 5
                  ? new StateError({
                      operation: "lock",
                      message: "Stack registry is locked by another operation; retry shortly",
                      cause: error.cause,
                    })
                  : error,
              ),
            );
            return yield* effect;
          }),
        (connection) =>
          Effect.try({
            try: () => connection.close(),
            catch: (cause) => stateError("unlock", cause),
          }),
      ),
    );
    return { read, list: list(), claims: claims(), save, remove, withLock };
  });

export const layer = (options: Options) =>
  Layer.effect(Service, makeState(options).pipe(Effect.map(Service.of)));
