import {
  Clock,
  Data,
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
import { errorCode, retrySharingViolation } from "./internal/sharing-violation.ts";
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
  /** The latest launch id; the next owner continues after it, so launch ids keep increasing. */
  launchId: Schema.optionalKey(Schema.Int),
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
  /** Omits saved Vector instances and their composition entries without rewriting the file. */
  readonly read: (id: string) => Effect.Effect<SavedStack | undefined, StateError>;
  /**
   * Persists the removal of saved Vector instances and deletes their stack-owned files. Call while
   * holding the stack's lease, before any of its services run.
   */
  readonly migrate: (id: string) => Effect.Effect<void, StateError>;
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
  /** The directory that holds the stack's persisted service logs. */
  readonly logsRoot: (id: string) => string;
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

const retainedEntries = (
  entries: unknown,
  retired: (entry: Readonly<Record<string, unknown>>) => boolean,
): unknown =>
  Array.isArray(entries)
    ? entries.filter((entry: unknown) => !(Predicate.isReadonlyObject(entry) && retired(entry)))
    : entries;

/**
 * Drops saved Vector instances, which the stack no longer runs, with every composition member,
 * dependency and port claim that references them. An instance with an unsafe id stays, so decoding
 * rejects the document.
 */
const withoutVectorInstances = (
  document: unknown,
): { readonly document: unknown; readonly removed: ReadonlyArray<string> } => {
  if (!Predicate.isReadonlyObject(document) || !Array.isArray(document.instances))
    return { document, removed: [] };
  const removed = document.instances.flatMap((instance: unknown) =>
    Predicate.isReadonlyObject(instance) &&
    Schema.is(SafeId)(instance.id) &&
    Predicate.isReadonlyObject(instance.creation) &&
    instance.creation.service === "vector"
      ? [instance.id]
      : [],
  );
  if (removed.length === 0) return { document, removed };
  const ids: ReadonlySet<unknown> = new Set(removed);
  const { composition } = document;
  return {
    removed,
    document: {
      ...document,
      instances: retainedEntries(document.instances, (instance) => ids.has(instance.id)),
      composition: Predicate.isReadonlyObject(composition)
        ? {
            ...composition,
            members: retainedEntries(composition.members, (member) => ids.has(member.id)),
            dependencies: retainedEntries(
              composition.dependencies,
              (dependency) => ids.has(dependency.from) || ids.has(dependency.to),
            ),
          }
        : composition,
      ports: retainedEntries(
        document.ports,
        ({ key }) => typeof key === "string" && removed.some((id) => key.startsWith(`${id}:`)),
      ),
    },
  };
};

const decodeState = (
  text: string,
  id: string,
  target: string,
): Effect.Effect<SavedStack, StateError> =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.flatMap((document) =>
      Schema.decodeUnknownEffect(SavedStack)(withoutVectorInstances(document).document),
    ),
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

const logsDirectory = "logs";

/** Resolves the persisted service logs directory of a stack without opening the state root. */
export const stackLogsRoot = (
  path: Path.Path,
  stateRoot: string,
  id: string,
): Effect.Effect<string, StateError> =>
  checkId(id).pipe(Effect.as(path.join(path.normalize(stateRoot), id, logsDirectory)));

const stateWritePrefix = ".state-write-";
/** A state write takes milliseconds, so a temporary directory this old belongs to a dead writer. */
const staleWriteAgeMillis = 24 * 60 * 60 * 1000;

/** Best-effort removal of temporary write directories a killed writer left behind. */
export const reapStaleWrites = (fs: FileSystem.FileSystem, path: Path.Path, root: string) =>
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

/**
 * Replaces `target` with `content` (mode 0600) through a temporary file in a fresh directory under
 * `directory`, which must share the target's file system, retrying Windows sharing violations.
 */
export const writeFileAtomically = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  options: {
    readonly directory: string;
    readonly target: string;
    readonly content: string;
    readonly platform?: NodeJS.Platform;
  },
): Effect.Effect<void, StateError> =>
  Effect.acquireUseRelease(
    fs
      .makeTempDirectory({ directory: options.directory, prefix: stateWritePrefix })
      .pipe(Effect.mapError((cause) => stateError("write", cause))),
    (directory) =>
      Effect.gen(function* () {
        const temporary = path.join(directory, path.basename(options.target));
        yield* fs
          .writeFileString(temporary, options.content, { mode: 0o600 })
          .pipe(Effect.mapError((cause) => stateError("write", cause)));
        yield* fs.rename(temporary, options.target).pipe(
          retrySharingViolation(options.platform),
          Effect.mapError(
            (cause) =>
              new StateError({
                operation: "publish",
                message: `Unable to publish state to ${options.target}${errorCode(cause) ? ` (${errorCode(cause)})` : ""}: ${cause instanceof Error ? cause.message : String(cause)}`,
                cause,
              }),
          ),
          Effect.withSpan("State.publish"),
        );
      }),
    (directory) =>
      fs
        .remove(directory, { recursive: true, force: true })
        .pipe(Effect.mapError((cause) => stateError("cleanup", cause))),
  );

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
    const logsRoot = (id: string) => path.join(stackRoot(id), logsDirectory);
    const retryShared = retrySharingViolation(options.platform);
    const retryTransientRead = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        retryShared,
        Effect.mapError((cause) => stateError("read", cause)),
      );
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
      fs.makeDirectory(stackRoot(id), { recursive: true, mode: 0o700 }).pipe(
        Effect.mapError((cause) => stateError("write", cause)),
        Effect.andThen(
          writeFileAtomically(fs, path, {
            directory: root,
            target,
            content: serialized,
            ...(options.platform === undefined ? {} : { platform: options.platform }),
          }),
        ),
      );
    const save = Effect.fn("State.save")(function* (state: SavedStack) {
      yield* checkId(state.id);
      const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(SavedStack))(state).pipe(
        Effect.mapError((cause) => stateError("encode", cause)),
      );
      yield* writeAtomically(state.id, statePath(state.id), serialized);
    });
    const remove = Effect.fn("State.remove")(function* (id: string) {
      yield* checkId(id);
      // Logs go before the state file, so a stack whose logs remain stays listed for another removal.
      yield* fs.remove(logsRoot(id), { recursive: true, force: true }).pipe(
        retryShared,
        Effect.mapError((cause) => stateError("remove", cause)),
      );
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
    /** An open file that was unlinked: SQLite IOERR_VNODE on macOS, IOERR_FSTAT on Linux. */
    const isMoved = (error: StateError) => hasErrcode(6922)(error) || hasErrcode(1802)(error);
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
    const vectorConfigRoot = (instanceRoot: string) => path.join(instanceRoot, "runtime", "vector");
    const isVectorRecipe = (entry: string) =>
      entry === "vector.yaml" ||
      entry === "vector-api.yaml" ||
      entry === "vector.rendered.yaml" ||
      entry.startsWith(".vector-write-");
    /**
     * Resolved instance data roots that still hold Vector recipe files. Found by layout rather than
     * by saved ids, so a cleanup that failed is retried after the document no longer names Vector.
     * A root whose config directory resolves elsewhere is skipped, so removal stays in the stack.
     */
    const vectorDataRoots = (id: string) =>
      Effect.gen(function* () {
        const dataRoot = path.join(stackRoot(id), "data");
        const entries = yield* fs.readDirectory(dataRoot).pipe(
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Effect.succeed([]),
          ),
          retryTransientRead,
        );
        if (entries.length === 0) return [];
        const realDataRoot = path.join(
          yield* fs.realPath(stackRoot(id)).pipe(retryTransientRead),
          "data",
        );
        const roots: Array<string> = [];
        for (const entry of entries.filter(Schema.is(SafeId))) {
          const instanceRoot = path.join(realDataRoot, entry);
          const configRoot = vectorConfigRoot(instanceRoot);
          // Another service's data directory may be unreadable to this process.
          const configEntries = yield* fs
            .realPath(vectorConfigRoot(path.join(dataRoot, entry)))
            .pipe(
              Effect.flatMap((resolved) =>
                resolved === configRoot ? fs.readDirectory(configRoot) : Effect.succeed([]),
              ),
              Effect.orElseSucceed((): ReadonlyArray<string> => []),
            );
          if (configEntries.some(isVectorRecipe)) roots.push(instanceRoot);
        }
        return roots;
      });
    // A caller's Vector configPath may live under the instance root, so only recipe files and
    // empty directories go.
    const removeVectorData = (instanceRoot: string) =>
      Effect.gen(function* () {
        const configRoot = vectorConfigRoot(instanceRoot);
        for (const entry of yield* fs.readDirectory(configRoot))
          if (isVectorRecipe(entry))
            yield* fs.remove(path.join(configRoot, entry), { recursive: true, force: true });
        for (const directory of [configRoot, path.dirname(configRoot), instanceRoot])
          yield* removeEmptyDirectory(directory);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `Unable to remove the Vector files in ${instanceRoot}; the next owner start retries`,
            cause,
          ),
        ),
      );
    /** Whether the saved document still holds a Vector instance. */
    const holdsVector = (target: string) =>
      Effect.gen(function* () {
        if (!(yield* fs.exists(target).pipe(retryTransientRead))) return false;
        const text = yield* fs.readFileString(target).pipe(retryTransientRead);
        const { removed } = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
          text,
        ).pipe(
          Effect.map(withoutVectorInstances),
          Effect.orElseSucceed(() => ({ removed: [] })),
        );
        return removed.length > 0;
      });
    /** What a migration still has to do, or `undefined` when the stack no longer holds Vector. */
    const vectorLeftovers = (id: string) =>
      Effect.gen(function* () {
        const legacy = yield* holdsVector(statePath(id));
        const candidates = yield* vectorDataRoots(id);
        if (!legacy && candidates.length === 0) return undefined;
        const saved = yield* read(id);
        // Vector files in a saved instance's root belong to that instance, e.g. a caller's config.
        const live = new Set(saved?.instances.map((instance) => instance.id));
        const roots = candidates.filter((root) => !live.has(path.basename(root)));
        return legacy || roots.length > 0
          ? { saved: legacy ? saved : undefined, roots }
          : undefined;
      });
    const migrate = Effect.fn("State.migrate")(function* (id: string) {
      yield* checkId(id);
      // Only a stack that still holds Vector takes the registry lock, to migrate it.
      if ((yield* vectorLeftovers(id)) === undefined) return;
      yield* withLock(
        Effect.gen(function* () {
          const leftovers = yield* vectorLeftovers(id);
          if (leftovers === undefined) return;
          yield* Effect.annotateCurrentSpan({ vector_data_roots: leftovers.roots.length });
          yield* Effect.forEach(leftovers.roots, removeVectorData, { discard: true });
          if (leftovers.saved !== undefined) yield* save(leftovers.saved);
        }),
      );
    });
    return {
      read,
      migrate,
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
      logsRoot,
    };
  });

export const layer = (options: Options) =>
  Layer.effect(Service, makeState(options).pipe(Effect.map(Service.of)));
