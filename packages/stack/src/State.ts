import {
  Clock,
  Data,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Context,
  Layer,
  Option,
  Path,
  Predicate,
  Schedule,
  Schema,
  Scope,
} from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem has no non-recursive directory removal operation.
import { rmdir } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem has no OS-owned cross-process lock primitive.
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
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

/** API and JWT signing keys that override the keys a stack derives by default. */
export const StackKeysInput = Schema.Struct({
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
export interface StackKeysInput extends Schema.Schema.Type<typeof StackKeysInput> {}

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

/** A session stack is destroyed when its creator exits; a detached stack outlives it. */
export const StackLifetime = Schema.Literals(["session", "detached"]);
export type StackLifetime = Schema.Schema.Type<typeof StackLifetime>;

export const SavedStack = Schema.Struct({
  id: SafeId,
  lifetime: StackLifetime,
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

/** What the current lease holder publishes: an owner's control endpoint, or a sweeper's marker. */
const LeaseHolder = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("owner"),
    port: PortClaim.fields.port,
    pid: Schema.Int,
    release: Schema.String,
    lifetime: StackLifetime,
    startedAt: Schema.String,
    secret: Schema.String,
  }),
  Schema.Struct({ role: Schema.Literal("sweeper"), pid: Schema.Int, startedAt: Schema.String }),
]);
type LeaseHolder = Schema.Schema.Type<typeof LeaseHolder>;

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
  /**
   * Holds the stack's owner lease for the enclosing scope, or returns `false` while another
   * process holds it. Releasing the lease of a removed stack deletes its directory.
   */
  readonly lease: (id: string) => Effect.Effect<boolean, StateError, Scope.Scope>;
  /** Reports whether any process currently holds the stack's owner lease. */
  readonly leased: (id: string) => Effect.Effect<boolean, StateError>;
  /** Only meaningful while the lease is held; a record left by a dead holder is stale. */
  readonly readHolder: (id: string) => Effect.Effect<LeaseHolder | undefined, StateError>;
  /** Written by the lease holder with owner-only permissions, since it carries the owner secret. */
  readonly publishHolder: (id: string, record: LeaseHolder) => Effect.Effect<void, StateError>;
  readonly retractHolder: (id: string) => Effect.Effect<void, StateError>;
  /** The file that receives the stack owner's stdout and stderr. */
  readonly ownerLog: (id: string) => string;
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
  /** Observes a lease request that found the lease held and is waiting for it. */
  readonly onLeaseContended?: (id: string) => Effect.Effect<void>;
}

const stateWritePrefix = ".state-write-";
/** A state write takes milliseconds, so a temporary directory this old belongs to a dead writer. */
const staleWriteAgeMillis = 24 * 60 * 60 * 1000;

/** Best-effort removal of temporary write directories a killed writer left behind. */
const reapStaleWrites = (fs: FileSystem.FileSystem, path: Path.Path, root: string) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const entries = yield* fs.readDirectory(root);
    yield* Effect.forEach(
      entries.filter((entry) => entry.startsWith(stateWritePrefix)),
      (entry) => {
        const candidate = path.join(root, entry);
        return fs.stat(candidate).pipe(
          Effect.flatMap((info) =>
            Option.exists(info.mtime, (mtime) => now - mtime.getTime() > staleWriteAgeMillis)
              ? fs.remove(candidate, { recursive: true, force: true })
              : Effect.void,
          ),
          Effect.ignore,
        );
      },
      { discard: true },
    );
  }).pipe(Effect.ignore);

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
    yield* reapStaleWrites(fs, path, root);

    const stackRoot = (id: string) => path.join(root, id);
    const statePath = (id: string) => path.join(stackRoot(id), "state.json");
    // Only lease code opens a lease file, for the same reason as the registry lock.
    const leasePath = (id: string) => path.join(stackRoot(id), "owner.lock");
    const ownerPath = (id: string) => path.join(stackRoot(id), "owner.json");
    const ownerLog = (id: string) => path.join(stackRoot(id), "owner.log");
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
    const writeAtomically = (id: string, target: string, serialized: string) =>
      Effect.gen(function* () {
        yield* fs
          .makeDirectory(stackRoot(id), { recursive: true, mode: 0o700 })
          .pipe(Effect.mapError((cause) => stateError("write", cause)));
        yield* Effect.acquireUseRelease(
          fs
            .makeTempDirectory({ directory: root, prefix: stateWritePrefix })
            .pipe(Effect.mapError((cause) => stateError("write", cause))),
          (directory) =>
            Effect.gen(function* () {
              const temporary = path.join(directory, path.basename(target));
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
    const save = Effect.fn("State.save")(function* (state: SavedStack) {
      yield* checkId(state.id);
      const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(SavedStack))(state).pipe(
        Effect.mapError((cause) => stateError("encode", cause)),
      );
      yield* writeAtomically(state.id, statePath(state.id), serialized);
    });
    const remove = Effect.fn("State.remove")(function* (id: string) {
      yield* checkId(id);
      for (const file of [statePath(id), ownerPath(id), ownerLog(id)])
        yield* fs
          .remove(file, { force: true })
          .pipe(Effect.mapError((cause) => stateError("remove", cause)));
      yield* removeEmptyDirectory(path.join(stackRoot(id), "data"));
      yield* removeEmptyDirectory(stackRoot(id));
    });
    const openLock = (file: string) =>
      Effect.try({
        try: () => new DatabaseSync(file),
        catch: (cause) => stateError("lock", cause),
      });
    /** Opens an existing lock file without creating a stray one. */
    const openExistingLock = (file: string) =>
      Effect.try({
        try: () => new DatabaseSync(new URL(`${pathToFileURL(file).href}?mode=rw`)),
        catch: (cause) => stateError("lock", cause),
      });
    const closeLock = (connection: DatabaseSync) =>
      Effect.try({
        try: () => connection.close(),
        catch: (cause) => stateError("unlock", cause),
      });
    const hasErrcode = (code: number) => (error: StateError) =>
      Predicate.hasProperty(error.cause, "errcode") && error.cause.errcode === code;
    const isBusy = hasErrcode(5);
    const isMissing = hasErrcode(14);
    /** macOS SQLite reports that an open database file was unlinked or replaced. */
    const isMoved = hasErrcode(6922);
    /** Takes the file's SQLite write lock on this connection, retrying contention on `schedule`. */
    const takeLock = (
      connection: DatabaseSync,
      schedule: Schedule.Schedule<unknown, StateError>,
      onContended: Effect.Effect<void> = Effect.void,
    ) =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => connection.exec("PRAGMA busy_timeout = 0"),
          catch: (cause) => stateError("lock", cause),
        });
        let contended = false;
        return yield* Effect.try({
          try: () => connection.exec("BEGIN IMMEDIATE"),
          catch: (cause) => stateError("lock", cause),
        }).pipe(
          Effect.tapError((error) =>
            isBusy(error) && !contended
              ? Effect.sync(() => {
                  contended = true;
                }).pipe(Effect.andThen(onContended))
              : Effect.void,
          ),
          Effect.retry({ schedule, while: isBusy }),
          Effect.as(true),
          Effect.catchIf(isBusy, () => Effect.succeed(false)),
        );
      });
    const withLock = Effect.fn("State.withLock")(<A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        openLock(lock),
        (connection) =>
          Effect.gen(function* () {
            const held = yield* takeLock(
              connection,
              Schedule.spaced("50 millis").pipe(Schedule.upTo({ duration: "5 seconds" })),
            );
            if (!held)
              return yield* new StateError({
                operation: "lock",
                message: "Stack registry is locked by another operation; retry shortly",
              });
            return yield* effect;
          }),
        closeLock,
      ),
    );
    /** Deletes the lease file of an unregistered stack; `false` means it is still in place. */
    const removeLeaseFile = (id: string) =>
      fs.exists(statePath(id)).pipe(
        Effect.flatMap((registered) =>
          registered ? Effect.void : fs.remove(leasePath(id), { force: true }),
        ),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    const fileIdentity = (file: string) =>
      fs.stat(file).pipe(
        Effect.map((info) => `${info.dev}:${Option.getOrElse(info.ino, () => "")}`),
        Effect.option,
      );
    /**
     * A waiter can open the lease file just before its holder unlinks it, and then lock the
     * unlinked file; comparing the path's file before opening and after locking rejects that.
     * Unlinking under the lock keeps new openers off a doomed file. Windows refuses to unlink an
     * open file, so only there does a second attempt follow the close.
     */
    const lease = Effect.fn("State.lease")(function* (id: string) {
      yield* checkId(id);
      const target = leasePath(id);
      const scope = yield* Scope.Scope;
      let held = false;
      let unlinked = false;
      yield* Effect.addFinalizer(() =>
        held
          ? (unlinked ? Effect.void : removeLeaseFile(id)).pipe(
              Effect.andThen(removeEmptyDirectory(stackRoot(id))),
              Effect.ignore,
            )
          : Effect.void,
      );
      const onContended = options.onLeaseContended?.(id) ?? Effect.void;
      for (let attempt = 0; attempt < 8; attempt++) {
        // A releasing holder may remove the empty stack directory at any moment.
        yield* fs
          .makeDirectory(stackRoot(id), { recursive: true, mode: 0o700 })
          .pipe(Effect.mapError((cause) => stateError("lease", cause)));
        const before = yield* fileIdentity(target);
        const attemptScope = yield* Scope.fork(scope, "sequential");
        const connection = yield* Effect.acquireRelease(openLock(target), (connection) =>
          closeLock(connection).pipe(
            Effect.catch((error) =>
              Effect.logWarning(`Unable to release stack lease ${id}`, error),
            ),
          ),
        ).pipe(
          Scope.provide(attemptScope),
          Effect.map(Option.some),
          Effect.catchIf(isMissing, () => Effect.succeed(Option.none<DatabaseSync>())),
        );
        if (Option.isNone(connection)) {
          yield* Scope.close(attemptScope, Exit.void);
          continue;
        }
        const acquired = yield* takeLock(
          connection.value,
          Schedule.spaced("25 millis").pipe(Schedule.upTo({ duration: "500 millis" })),
          onContended,
        ).pipe(
          Effect.map((held) => (held ? "held" : "busy")),
          Effect.catchIf(isMoved, () => Effect.succeed("moved" as const)),
        );
        if (acquired === "busy") {
          yield* Scope.close(attemptScope, Exit.void);
          return false;
        }
        const after = acquired === "moved" ? Option.none() : yield* fileIdentity(target);
        if (Option.isSome(before) && Option.isSome(after) && before.value === after.value) {
          held = true;
          yield* Scope.addFinalizer(
            attemptScope,
            removeLeaseFile(id).pipe(
              Effect.map((removed) => {
                unlinked = removed;
              }),
            ),
          );
          return true;
        }
        yield* Scope.close(attemptScope, Exit.void);
      }
      return yield* stateError("lease", `The lease file of stack ${id} keeps changing`);
    });
    const leased = Effect.fn("State.leased")(function* (id: string) {
      yield* checkId(id);
      return yield* Effect.acquireUseRelease(
        openExistingLock(leasePath(id)),
        (connection) =>
          takeLock(connection, Schedule.recurs(0)).pipe(Effect.map((acquired) => !acquired)),
        closeLock,
      ).pipe(
        // A lease file that is missing, or that its holder unlinked meanwhile, is not held.
        Effect.catchIf(
          (error) => isMissing(error) || isMoved(error),
          () => Effect.succeed(false),
        ),
      );
    });
    const decodeHolder = Schema.decodeEffect(Schema.fromJsonString(LeaseHolder));
    const readHolder = Effect.fn("State.readHolder")(function* (id: string) {
      yield* checkId(id);
      const target = ownerPath(id);
      // The holder may retract its record at any moment, so a missing record is not an error.
      const text = yield* fs.readFileString(target).pipe(
        Effect.map(Option.some),
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(Option.none<string>()),
        ),
        retryTransientRead,
      );
      if (Option.isNone(text)) return undefined;
      return yield* decodeHolder(text.value).pipe(
        Effect.mapError((cause) => stateError("decode", `Unable to decode ${target}: ${cause}`)),
      );
    });
    const publishHolder = Effect.fn("State.publishHolder")(function* (
      id: string,
      record: LeaseHolder,
    ) {
      yield* checkId(id);
      const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(LeaseHolder))(
        record,
      ).pipe(Effect.mapError((cause) => stateError("encode", cause)));
      yield* writeAtomically(id, ownerPath(id), serialized);
    });
    const retractHolder = Effect.fn("State.retractHolder")(function* (id: string) {
      yield* checkId(id);
      yield* fs
        .remove(ownerPath(id), { force: true })
        .pipe(Effect.mapError((cause) => stateError("remove", cause)));
    });
    return {
      read,
      list: list(),
      claims: claims(),
      save,
      remove,
      withLock,
      lease,
      leased,
      readHolder,
      publishHolder,
      retractHolder,
      ownerLog,
    };
  });

export const layer = (options: Options) =>
  Layer.effect(Service, makeState(options).pipe(Effect.map(Service.of)));
