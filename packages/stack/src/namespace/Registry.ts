import { Effect, Exit, FileSystem, Path, Schedule, Schema, Scope } from "effect";
import { CompositionConfig } from "../Orchestrator.ts";
import { ServiceCreation } from "../services/Catalog.ts";
import { namespaceError, retryTransientRead, type NamespaceError } from "./Capabilities.ts";
import { CLAIMS_FILE } from "./Claims.ts";
import { OWNER_FILE, OWNER_LOG_FILE } from "./Lease.ts";
import * as Publication from "./Publication.ts";
import { removeEmptyDirectory } from "./drivers/FileSystem.ts";
import { acquireLock, isBusy, takeLock } from "./drivers/Sqlite.ts";

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

export const PortClaim = Schema.Struct({
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
  runtime: Schema.Literals(["native", "docker"]),
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

export interface Interface {
  readonly read: (id: string) => Effect.Effect<SavedStack | undefined, NamespaceError>;
  /** Skips each stack entry that stays unreadable after transient retries, reporting it to `onInvalidState`. */
  readonly list: Effect.Effect<ReadonlyArray<SavedStack>, NamespaceError>;
  readonly save: (state: SavedStack) => Effect.Effect<void, NamespaceError>;
  readonly remove: (id: string) => Effect.Effect<void, NamespaceError>;
  /** Not reentrant; wrap metadata updates here, while Ports operations acquire this lock themselves. */
  readonly withLock: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | NamespaceError, R>;
}

const checkId = (id: string): Effect.Effect<void, NamespaceError> =>
  Schema.is(SafeId)(id)
    ? Effect.void
    : Effect.fail(namespaceError("identity", `Invalid state id: ${id}`));

const decodeState = (
  text: string,
  id: string,
  target: string,
): Effect.Effect<SavedStack, NamespaceError> =>
  Schema.decodeEffect(Schema.fromJsonString(SavedStack))(text).pipe(
    Effect.mapError((cause) =>
      namespaceError(
        "decode",
        `Unable to decode state ${target} for stack ${id}: ${cause.message}`,
      ),
    ),
  );

export interface Options {
  readonly root: string;
  readonly platform?: NodeJS.Platform;
  readonly onInvalidState?: (id: string, error: NamespaceError) => Effect.Effect<void>;
}

export const make = (
  options: Options,
): Effect.Effect<Interface, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = options.root;
    const lock = path.join(root, ".registry-lock.sqlite");

    const stackRoot = (id: string) => path.join(root, id);
    const statePath = (id: string) => path.join(stackRoot(id), "state.json");
    const retryRead = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        retryTransientRead(options.platform),
        Effect.mapError((cause) => namespaceError("read", cause)),
      );
    const read = Effect.fn("Namespace.Registry.read")(function* (id: string) {
      yield* checkId(id);
      const target = statePath(id);
      const exists = yield* fs.exists(target).pipe(retryRead);
      if (!exists) return undefined;
      const text = yield* fs.readFileString(target).pipe(retryRead);
      const state = yield* decodeState(text, id, target);
      if (state.id !== id)
        return yield* namespaceError("identity", "State document identity does not match its path");
      return state;
    });
    const stackIds = fs.readDirectory(root).pipe(
      Effect.map((entries) => entries.filter(Schema.is(SafeId))),
      Effect.mapError((cause) => namespaceError("list", cause)),
    );
    const readEntries = <A>(
      readEntry: (id: string) => Effect.Effect<A | undefined, NamespaceError>,
      onSkipped: (id: string, error: NamespaceError) => Effect.Effect<void>,
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
    const list = Effect.fn("Namespace.Registry.list")(() =>
      readEntries(read, (id, error) => options.onInvalidState?.(id, error) ?? Effect.void),
    );
    const save = Effect.fn("Namespace.Registry.save")(function* (state: SavedStack) {
      yield* checkId(state.id);
      yield* fs
        .makeDirectory(stackRoot(state.id), { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError((cause) => namespaceError("write", cause)));
      const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(SavedStack))(state).pipe(
        Effect.mapError((cause) => namespaceError("encode", cause)),
      );
      yield* Publication.publish(fs, path, {
        target: statePath(state.id),
        content: serialized,
        platform: options.platform,
      });
    });
    const remove = Effect.fn("Namespace.Registry.remove")(function* (id: string) {
      yield* checkId(id);
      for (const file of [
        statePath(id),
        path.join(stackRoot(id), OWNER_FILE),
        path.join(stackRoot(id), OWNER_LOG_FILE),
        path.join(stackRoot(id), CLAIMS_FILE),
      ])
        yield* fs
          .remove(file, { force: true })
          .pipe(Effect.mapError((cause) => namespaceError("remove", cause)));
      // The container-env scratch directory is removed registration-independently by the owner
      // (Owner.ts's `removeContainerEnvRoot`, shared by destroy and abandonment); by the time this
      // runs for a confirmed destroy, `data` is already empty of it.
      yield* removeEmptyDirectory(path.join(stackRoot(id), "data"));
      yield* removeEmptyDirectory(stackRoot(id));
    });
    /**
     * One attempt: forks `attemptScope` under `guardScope` before opening anything, so there is
     * always a scope to close if the open or the `BEGIN IMMEDIATE` below fails or defects. Runs
     * uninterruptibly as a single unit; the retry waiting on busy, and `effect` once this
     * succeeds, both stay interruptible around it.
     */
    const acquireAttempt = (
      guardScope: Scope.Scope,
    ): Effect.Effect<Scope.Closeable, NamespaceError> =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const attemptScope = yield* Scope.fork(guardScope, "sequential");
          yield* acquireLock(lock, "create").pipe(
            Scope.provide(attemptScope),
            Effect.flatMap(takeLock),
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? Scope.close(attemptScope, exit) : Effect.void,
            ),
          );
          return attemptScope;
        }),
      );
    /**
     * Holds the lock in its own standalone scope, so `effect`'s ambient scope (for example a port
     * listener it binds) stays whatever the caller already had, not one this lock closes early.
     */
    const withLock = Effect.fn("Namespace.Registry.withLock")(
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          Scope.make(),
          (guardScope) =>
            acquireAttempt(guardScope).pipe(
              Effect.retry({
                schedule: Schedule.spaced("50 millis").pipe(
                  Schedule.upTo({ duration: "5 seconds" }),
                ),
                while: isBusy,
              }),
              Effect.catchIf(isBusy, () =>
                namespaceError(
                  "lock",
                  "Stack registry is locked by another operation; retry shortly",
                ),
              ),
              Effect.andThen(effect),
            ),
          (guardScope, exit) => Scope.close(guardScope, exit),
        ),
    );

    return { read, list: list(), save, remove, withLock };
  });
