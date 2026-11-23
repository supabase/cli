import { Clock, Effect, FileSystem, Option, Path, Schema, Scope } from "effect";
import { CompositionConfig } from "../Orchestrator.ts";
import { ServiceCreation } from "../services/Catalog.ts";
import { SafeId } from "../identity/SafeId.ts";
import { retrySharingViolation } from "../internal/sharing-violation.ts";
import { namespaceError, type NamespaceError } from "./Capabilities.ts";
import { OWNER_FILE, OWNER_LOG_FILE } from "./Lease.ts";
import { stackLogsRoot } from "./Paths.ts";
import * as Publication from "./Publication.ts";
import { removeEmptyDirectory } from "./drivers/FileSystem.ts";
import { holdLock } from "./Lock.ts";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** How long a destroyed stack's empty directories stay, so a same-id restart finds them. */
const DESTROYED_RETENTION_MILLIS = 10 * 60 * 1000;

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
});
export interface SavedStack extends Schema.Schema.Type<typeof SavedStack> {}

export interface Interface {
  readonly read: (id: string) => Effect.Effect<SavedStack | undefined, NamespaceError>;
  /** Skips each stack entry that stays unreadable after transient retries, reporting it to `onInvalidState`. */
  readonly list: Effect.Effect<ReadonlyArray<SavedStack>, NamespaceError>;
  readonly save: (state: SavedStack) => Effect.Effect<void, NamespaceError>;
  readonly remove: (id: string) => Effect.Effect<void, NamespaceError>;
  /** Removes the empty directories `remove` left for stacks destroyed over ten minutes ago, other than `keep`. */
  readonly pruneDestroyed: (keep: string) => Effect.Effect<void, NamespaceError>;
  /** Not reentrant; wrap metadata updates here, while Ports operations acquire this lock themselves. */
  readonly withLock: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | NamespaceError, R>;
}

const checkId = (id: string): Effect.Effect<void, NamespaceError> =>
  Schema.is(SafeId)(id)
    ? Effect.void
    : Effect.fail(namespaceError("identity", `Invalid state id: ${id}`));

/**
 * A stack the previous CLI saved lists a `sparkmeta` service, a kind that no longer exists. Dropping it on read lets
 * the stack stop and start again with its Spark database.
 */
const withoutRetiredServices = (state: unknown): unknown => {
  if (!isRecord(state) || !Array.isArray(state.instances) || !isRecord(state.composition))
    return state;
  const retired = state.instances.flatMap((instance: unknown) =>
    isRecord(instance) &&
    isRecord(instance.creation) &&
    instance.creation.service === "sparkmeta" &&
    typeof instance.id === "string"
      ? [instance.id]
      : [],
  );
  if (retired.length === 0) return state;
  const gone = new Set<unknown>(retired);
  const kept = (items: unknown, ...keys: ReadonlyArray<string>) =>
    Array.isArray(items)
      ? items.filter(
          (item: unknown) => !(isRecord(item) && keys.some((key) => gone.has(item[key]))),
        )
      : items;
  return {
    ...state,
    instances: kept(state.instances, "id"),
    composition: {
      ...state.composition,
      members: kept(state.composition.members, "id"),
      dependencies: kept(state.composition.dependencies, "from", "to"),
    },
  };
};

/**
 * The previous CLI told Studio the engine through sparkmeta, so the Studio it saved for a Spark stack has no
 * `postgresEngine`. A stack with a Spark service is a Spark project: its Studio gets the engine on read, as
 * `supabase start` gives it, so a restart from the saved state keeps Studio's Spark queries.
 */
const withSparkStudioEngine = (state: unknown): unknown => {
  if (!isRecord(state) || !Array.isArray(state.instances)) return state;
  const creationOf = (instance: unknown) =>
    isRecord(instance) && isRecord(instance.creation) ? instance.creation : undefined;
  if (!state.instances.some((instance: unknown) => creationOf(instance)?.service === "spark"))
    return state;
  return {
    ...state,
    instances: state.instances.map((instance: unknown) => {
      const creation = creationOf(instance);
      if (!isRecord(instance) || creation?.service !== "studio") return instance;
      const config = isRecord(creation.config) ? creation.config : {};
      if (config.postgresEngine !== undefined) return instance;
      return {
        ...instance,
        creation: { ...creation, config: { ...config, postgresEngine: "spark" } },
      };
    }),
  };
};

const decodeState = (
  text: string,
  id: string,
  target: string,
): Effect.Effect<SavedStack, NamespaceError> =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.map(withoutRetiredServices),
    Effect.map(withSparkStudioEngine),
    Effect.flatMap(Schema.decodeUnknownEffect(SavedStack)),
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
        retrySharingViolation(options.platform),
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
      // Logs go before the state file, so a stack whose logs remain stays listed for another removal.
      yield* fs.remove(stackLogsRoot(path, root, id), { recursive: true, force: true }).pipe(
        retrySharingViolation(options.platform),
        Effect.mapError((cause) => namespaceError("remove", cause)),
      );
      for (const file of [
        statePath(id),
        path.join(stackRoot(id), OWNER_FILE),
        path.join(stackRoot(id), OWNER_LOG_FILE),
      ])
        yield* fs
          .remove(file, { force: true })
          .pipe(Effect.mapError((cause) => namespaceError("remove", cause)));
      // The stack and data directories stay: deleting and recreating them for a restart under the
      // same id lets the container engine's file share report fresh bind sources as missing.
    });
    const isDestroyedShell = Effect.fnUntraced(function* (id: string, now: number) {
      const directory = stackRoot(id);
      if ((yield* fs.stat(directory)).type !== "Directory") return false;
      const entries = yield* fs.readDirectory(directory);
      if (entries.length !== 1 || entries[0] !== "data") return false;
      const data = path.join(directory, "data");
      if ((yield* fs.stat(data)).type !== "Directory") return false;
      if ((yield* fs.readDirectory(data)).length > 0) return false;
      // Read after the contents, so a destroy that just emptied the directory counts as recent.
      const modified = Option.getOrUndefined((yield* fs.stat(directory)).mtime)?.getTime();
      return modified !== undefined && now - modified >= DESTROYED_RETENTION_MILLIS;
    });
    /**
     * Holds the lock in its own standalone scope, so `effect`'s ambient scope (for example a port
     * listener it binds) stays whatever the caller already had, not one this lock closes early.
     */
    const withLock = Effect.fn("Namespace.Registry.withLock")(
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          Scope.make(),
          (guardScope) =>
            holdLock(lock, "5 seconds", "Stack registry").pipe(
              Scope.provide(guardScope),
              Effect.andThen(effect),
            ),
          (guardScope, exit) => Scope.close(guardScope, exit),
        ),
    );

    const pruneDestroyed = Effect.fn("Namespace.Registry.pruneDestroyed")(function* (keep: string) {
      const now = yield* Clock.currentTimeMillis;
      let removed = 0;
      for (const id of yield* stackIds) {
        if (id === keep) continue;
        // Rechecked under the registry lock: a same-id recreate either saved its state before the
        // check or waits until the directories are gone.
        const pruned = yield* Effect.gen(function* () {
          if (!(yield* isDestroyedShell(id, now))) return false;
          return yield* withLock(
            Effect.gen(function* () {
              if (!(yield* isDestroyedShell(id, now))) return false;
              yield* removeEmptyDirectory(path.join(stackRoot(id), "data"));
              yield* removeEmptyDirectory(stackRoot(id));
              return true;
            }),
          );
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning(`Could not prune destroyed stack directory ${id}`, error).pipe(
              Effect.as(false),
            ),
          ),
        );
        if (pruned) removed += 1;
      }
      yield* Effect.annotateCurrentSpan({ removed });
    });

    return { read, list: list(), save, remove, pruneDestroyed, withLock };
  });
