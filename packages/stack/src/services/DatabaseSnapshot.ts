// oxlint-disable-next-line effecttsgo/node-builtin-import -- SQLite is the cross-process lock primitive.
import { DatabaseSync } from "node:sqlite";
import {
  Clock,
  Crypto,
  Data,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Predicate,
  Schedule,
  Schema,
} from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { postgresVersion } from "../Artifacts.ts";
import { failureMessage } from "../internal/failure-message.ts";
import { copyDirectory, type DirectoryCopyError } from "../storage/DirectoryCopy.ts";
import type { DatabaseRuntime } from "./Database.ts";

export class DatabaseSnapshotError extends Schema.TaggedError<DatabaseSnapshotError>()(
  "DatabaseSnapshotError",
  { operation: Schema.String, message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

const errorFor = (operation: string, cause: unknown) =>
  Schema.is(DatabaseSnapshotError)(cause)
    ? cause
    : new DatabaseSnapshotError({
        operation,
        message: failureMessage(cause),
        cause,
      });

const SnapshotStop = Schema.Literals(["nonempty", "miss", "descriptor", "major", "running"]);
/** Names the guard that stopped a snapshot program. */
type SnapshotStop = typeof SnapshotStop.Type;
/** Decodes a stop name reported by a backend outside this process. */
export const decodeSnapshotStop = Schema.decodeUnknownEffect(SnapshotStop);

/**
 * One filesystem operation of a snapshot program. Guards stop the program with an outcome
 * instead of failing. `Rename` creates the destination's parent and refuses to replace
 * anything but an empty directory; an optional rename runs only when its source exists and
 * its destination does not. `Recover` moves each `retired-<digest>-<token>` stage back to
 * its entry when that entry is missing.
 */
export type SnapshotStep = Data.TaggedEnum<{
  Ensure: { readonly directory: string };
  Clear: { readonly directory: string };
  Recover: { readonly stages: string; readonly entries: string };
  Expect: { readonly path: string; readonly present: boolean; readonly otherwise: SnapshotStop };
  ExpectEmpty: { readonly directory: string; readonly otherwise: SnapshotStop };
  ExpectText: { readonly file: string; readonly text: string; readonly otherwise: SnapshotStop };
  Copy: { readonly from: string; readonly to: string };
  Adopt: { readonly directory: string };
  Write: { readonly file: string; readonly text: string };
  Rename: { readonly from: string; readonly to: string; readonly optional: boolean };
  Remove: { readonly path: string };
  Touch: { readonly path: string };
  Prune: { readonly directory: string; readonly keep: number; readonly except: string };
}>;
export const SnapshotStep = Data.taggedEnum<SnapshotStep>();

/** Result of a snapshot program; a stopped `ExpectText` carries the file's actual text. */
export type SnapshotRun = Data.TaggedEnum<{
  Completed: {};
  Stopped: { readonly outcome: SnapshotStop; readonly text: string };
}>;
export const SnapshotRun = Data.taggedEnum<SnapshotRun>();

/**
 * Where a snapshot lives: the shared cache keeps a bounded number of entries across stacks, and an
 * instance keeps its own entries, outside that retention, until the instance is destroyed.
 */
export const snapshotScopes = ["cache", "instance"] as const;
export type SnapshotScope = (typeof snapshotScopes)[number];

/** Directory in a database instance root that holds its instance-scoped snapshots. */
export const instanceSnapshotsDirectory = ".supabase-snapshots";

/** Filesystem namespace in which one engine stores snapshots and database data. */
export interface SnapshotBackend {
  /** Host file whose SQLite write lock serializes operations on this snapshot store. */
  readonly lockFile: string;
  readonly entries: string;
  readonly stages: string;
  /** Holds restore stages on the filesystem that holds `data`. */
  readonly restoreStages: string;
  readonly data: string;
  readonly join: (...parts: ReadonlyArray<string>) => string;
  /** Runs every step in order, in one round trip where the backend is remote. */
  readonly run: (
    steps: ReadonlyArray<SnapshotStep>,
  ) => Effect.Effect<SnapshotRun, DatabaseSnapshotError>;
}

/** Cache-scoped entries kept besides the one just saved; instance-scoped checkpoints are never pruned. */
const retainedPrevious = 2;
const format = "supabase-database-snapshot-v1" as const;
const runtimes = Schema.Literals(["native", "docker", "podman"]);
const SnapshotIdentity = Schema.Struct({
  format: Schema.Literal(format),
  version: Schema.String,
  runtime: runtimes,
  platform: Schema.String,
  arch: Schema.String,
  profile: Schema.Literal("supabase"),
  logicalKey: Schema.String,
});
const SnapshotDescriptor = Schema.Struct({ ...SnapshotIdentity.fields, keyDigest: Schema.String });
const ReadyMarker = Schema.Struct({
  version: Schema.String,
  runtime: runtimes,
  profile: Schema.Literal("supabase"),
});

const withStoreLock = <A, E>(lockFile: string, effect: Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => new DatabaseSync(lockFile),
      catch: (cause) => errorFor("lock", cause),
    }),
    (connection) =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => connection.exec("PRAGMA busy_timeout = 0"),
          catch: (cause) => errorFor("lock", cause),
        });
        yield* Effect.try({
          try: () => connection.exec("BEGIN IMMEDIATE"),
          catch: (cause) => errorFor("lock", cause),
        }).pipe(
          Effect.retry({
            schedule: Schedule.spaced("50 millis").pipe(Schedule.upTo({ duration: "120 seconds" })),
            while: (cause) =>
              Predicate.hasProperty(cause.cause, "errcode") && cause.cause.errcode === 5,
          }),
        );
        return yield* effect;
      }),
    (connection) =>
      Effect.try({
        try: () => connection.close(),
        catch: (cause) => errorFor("unlock", cause),
      }),
  );

/** Saves and restores database data through the snapshot protocol, with one backend per scope. */
export const makeSnapshotStore = Effect.fn("DatabaseSnapshot.makeStore")(function* (options: {
  readonly backends: { readonly [Scope in SnapshotScope]: SnapshotBackend };
  readonly instanceRoot: string;
  readonly runtime: DatabaseRuntime;
  readonly version: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const { backends, runtime, version } = options;
  const { Adopt, Clear, Copy, Ensure, Expect, ExpectEmpty, ExpectText } = SnapshotStep;
  const { Prune, Recover, Remove, Rename, Touch, Write } = SnapshotStep;
  const major = version.split(".")[0] ?? version;
  const markerPath = path.join(options.instanceRoot, ".supabase-database-ready.json");
  const mapError = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError((cause) => errorFor(operation, cause)));

  const describe = Effect.fnUntraced(
    function* (logicalKey: string) {
      const identity = {
        format,
        version,
        runtime,
        platform: process.platform,
        arch: process.arch,
        profile: "supabase" as const,
        logicalKey,
      };
      const bytes = yield* Schema.encodeEffect(Schema.fromJsonString(SnapshotIdentity))(
        identity,
      ).pipe(
        Effect.flatMap((encoded) => crypto.digest("SHA-256", new TextEncoder().encode(encoded))),
      );
      const keyDigest = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      const descriptor = yield* Schema.encodeEffect(Schema.fromJsonString(SnapshotDescriptor))({
        ...identity,
        keyDigest,
      });
      return { keyDigest, descriptor };
    },
    Effect.mapError((cause) => errorFor("descriptor", cause)),
  );

  const locked = <A>(backend: SnapshotBackend, effect: Effect.Effect<A, DatabaseSnapshotError>) =>
    mapError(
      "lock",
      fs.makeDirectory(path.dirname(backend.lockFile), { recursive: true, mode: 0o700 }),
    ).pipe(Effect.andThen(withStoreLock(backend.lockFile, effect)));
  const token = mapError("stage", crypto.randomUUIDv4);
  // Compensation also runs after an interrupt; a failed compensation must not hide the
  // failure it follows.
  const compensate =
    (backend: SnapshotBackend, steps: ReadonlyArray<SnapshotStep>) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.uninterruptible(
                backend.run(steps).pipe(Effect.catch(Effect.logWarning), Effect.asVoid),
              ),
        ),
      );
  const reclaimStages = (backend: SnapshotBackend) => [
    Recover({ stages: backend.stages, entries: backend.entries }),
    Clear({ directory: backend.stages }),
  ];

  const saveSnapshot = Effect.fn("DatabaseSnapshot.save")(function* (
    logicalKey: string,
    scope: SnapshotScope = "cache",
  ) {
    const backend = backends[scope];
    const ready = yield* mapError(
      "ready",
      fs
        .readFileString(markerPath)
        .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ReadyMarker)))),
    );
    if (ready.version !== version || ready.runtime !== runtime)
      return yield* errorFor("ready", "Database readiness marker does not match the instance");
    const { keyDigest, descriptor } = yield* describe(logicalKey);
    yield* locked(
      backend,
      Effect.gen(function* () {
        const id = yield* token;
        const stage = backend.join(backend.stages, id);
        const retired = backend.join(backend.stages, `retired-${keyDigest}-${id}`);
        const target = backend.join(backend.entries, keyDigest);
        const result = yield* backend
          .run([
            Ensure({ directory: backend.entries }),
            ...reclaimStages(backend),
            Expect({
              path: backend.join(backend.data, "postmaster.pid"),
              present: false,
              otherwise: "running",
            }),
            ExpectText({
              file: backend.join(backend.data, "PG_VERSION"),
              text: major,
              otherwise: "major",
            }),
            Ensure({ directory: stage }),
            Copy({ from: backend.data, to: backend.join(stage, "data") }),
            Write({ file: backend.join(stage, "descriptor.json"), text: descriptor }),
            Rename({ from: target, to: retired, optional: true }),
            Rename({ from: stage, to: target, optional: false }),
            Remove({ path: retired }),
            Touch({ path: target }),
            ...(scope === "cache"
              ? [Prune({ directory: backend.entries, keep: retainedPrevious, except: keyDigest })]
              : []),
          ])
          .pipe(
            compensate(backend, [
              Rename({ from: retired, to: target, optional: true }),
              Remove({ path: stage }),
            ]),
          );
        if (result._tag === "Stopped")
          return yield* result.outcome === "running"
            ? errorFor("data", "Database must be stopped before snapshotting")
            : errorFor("data", "Database data is missing or has another PostgreSQL major version");
      }),
    );
  });

  const publishReadyMarker = Effect.fnUntraced(
    function* (id: string) {
      const staged = `${markerPath}.${id}`;
      const marker = yield* Schema.encodeEffect(Schema.fromJsonString(ReadyMarker))({
        version,
        runtime,
        profile: "supabase",
      });
      yield* fs.writeFileString(staged, marker, { mode: 0o600 });
      yield* fs
        .rename(staged, markerPath)
        .pipe(Effect.onError(() => fs.remove(staged, { force: true }).pipe(Effect.ignore)));
    },
    Effect.mapError((cause) => errorFor("ready", cause)),
  );

  const restoreSnapshot = Effect.fn("DatabaseSnapshot.restore")(function* (
    logicalKey: string,
    scope: SnapshotScope = "cache",
  ) {
    const backend = backends[scope];
    const { keyDigest, descriptor } = yield* describe(logicalKey);
    return yield* locked(
      backend,
      Effect.gen(function* () {
        const id = yield* token;
        const stage = backend.join(backend.restoreStages, id);
        const published = backend.join(backend.restoreStages, `${id}.published`);
        const entry = backend.join(backend.entries, keyDigest);
        // Once the published record exists the target was empty, so rollback may clear it.
        const rollback = [
          Remove({ path: stage }),
          Expect({ path: published, present: true, otherwise: "miss" }),
          Clear({ directory: backend.data }),
        ];
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const result = yield* restore(
              backend.run([
                Ensure({ directory: backend.entries }),
                ...reclaimStages(backend),
                ...(backend.restoreStages === backend.stages
                  ? []
                  : [Clear({ directory: backend.restoreStages })]),
                ExpectEmpty({ directory: backend.data, otherwise: "nonempty" }),
                Expect({ path: entry, present: true, otherwise: "miss" }),
                ExpectText({
                  file: backend.join(entry, "descriptor.json"),
                  text: descriptor,
                  otherwise: "descriptor",
                }),
                ExpectText({
                  file: backend.join(entry, "data", "PG_VERSION"),
                  text: major,
                  otherwise: "major",
                }),
                Expect({
                  path: backend.join(entry, "data", "postmaster.pid"),
                  present: false,
                  otherwise: "running",
                }),
                Copy({ from: backend.join(entry, "data"), to: stage }),
                Adopt({ directory: stage }),
                Touch({ path: entry }),
                Write({ file: published, text: id }),
                Rename({ from: stage, to: backend.data, optional: false }),
              ]),
            );
            if (result._tag === "Stopped") {
              switch (result.outcome) {
                case "miss":
                  return false;
                case "descriptor":
                  // A well-formed descriptor for another identity is a miss; anything else is corrupt.
                  return yield* Schema.decodeEffect(Schema.fromJsonString(SnapshotDescriptor))(
                    result.text,
                  ).pipe(
                    Effect.as(false),
                    Effect.mapError((cause) => errorFor("descriptor", cause)),
                  );
                case "nonempty":
                  return yield* errorFor("restore", "Restore target data directory must be empty");
                case "major":
                  return yield* errorFor(
                    "validate",
                    "Snapshot PostgreSQL major version is incompatible",
                  );
                case "running":
                  return yield* errorFor("validate", "Snapshot contains a running database");
              }
            }
            yield* publishReadyMarker(id);
            return true;
          }),
        ).pipe(compensate(backend, rollback));
      }),
    );
  });

  return { saveSnapshot, restoreSnapshot };
});

/** Interprets snapshot programs directly on the host filesystem, keeping entries under `root`. */
const makeNativeSnapshotBackend = Effect.fnUntraced(function* (options: {
  readonly instanceRoot: string;
  readonly root: string;
  readonly lockFile: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { instanceRoot, root } = options;
  const exists = (target: string) => fs.exists(target);
  const isEmptyDirectory = (target: string) =>
    fs.readDirectory(target).pipe(Effect.map((names) => names.length === 0));
  const readText = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.map((text) => text.replace(/\n+$/u, "")),
      Effect.orElseSucceed(() => undefined),
    );
  const proceed = Option.none<SnapshotRun>();
  const stop = (outcome: SnapshotStop, text = "") =>
    Option.some(SnapshotRun.Stopped({ outcome, text }));
  const step = (
    current: SnapshotStep,
  ): Effect.Effect<
    Option.Option<SnapshotRun>,
    PlatformError | DirectoryCopyError | DatabaseSnapshotError
  > =>
    SnapshotStep.$match(current, {
      Ensure: ({ directory }) =>
        fs.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(Effect.as(proceed)),
      Clear: ({ directory }) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
          for (const name of yield* fs.readDirectory(directory))
            yield* fs.remove(path.join(directory, name), { recursive: true, force: true });
          return proceed;
        }),
      Recover: ({ stages, entries }) =>
        Effect.gen(function* () {
          if (!(yield* exists(stages))) return proceed;
          for (const name of yield* fs.readDirectory(stages)) {
            const digest = /^retired-([0-9a-f]+)-/u.exec(name)?.[1];
            if (digest === undefined || (yield* exists(path.join(entries, digest)))) continue;
            yield* fs.makeDirectory(entries, { recursive: true, mode: 0o700 });
            yield* fs.rename(path.join(stages, name), path.join(entries, digest));
          }
          return proceed;
        }),
      Expect: ({ path: target, present, otherwise }) =>
        exists(target).pipe(Effect.map((found) => (found === present ? proceed : stop(otherwise)))),
      ExpectEmpty: ({ directory, otherwise }) =>
        Effect.gen(function* () {
          if (!(yield* exists(directory)) || (yield* isEmptyDirectory(directory))) return proceed;
          return stop(otherwise);
        }),
      ExpectText: ({ file, text, otherwise }) =>
        readText(file).pipe(
          Effect.map((actual) => (actual === text ? proceed : stop(otherwise, actual ?? ""))),
        ),
      Copy: ({ from, to }) =>
        copyDirectory(from, to).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.as(proceed),
        ),
      // Native data already belongs to the user that runs the database.
      Adopt: () => Effect.succeedNone,
      Write: ({ file, text }) =>
        fs.writeFileString(file, text, { mode: 0o600 }).pipe(Effect.as(proceed)),
      Rename: ({ from, to, optional }) =>
        Effect.gen(function* () {
          const destination = yield* exists(to);
          if (optional && (destination || !(yield* exists(from)))) return proceed;
          if (destination) {
            if (!(yield* isEmptyDirectory(to)))
              return yield* errorFor("rename", `${to} already exists`);
            yield* fs.remove(to, { recursive: true });
          }
          yield* fs.makeDirectory(path.dirname(to), { recursive: true, mode: 0o700 });
          yield* fs.rename(from, to);
          return proceed;
        }),
      Remove: ({ path: target }) =>
        fs.remove(target, { recursive: true, force: true }).pipe(Effect.as(proceed)),
      Touch: ({ path: target }) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => fs.utimes(target, now / 1_000, now / 1_000)),
          Effect.as(proceed),
        ),
      Prune: ({ directory, keep, except }) =>
        Effect.gen(function* () {
          const entries: Array<{ readonly name: string; readonly mtime: number }> = [];
          for (const name of yield* fs.readDirectory(directory)) {
            if (name === except) continue;
            const info = yield* fs.stat(path.join(directory, name));
            const mtime = Option.match(info.mtime, {
              onNone: () => 0,
              onSome: (date) => date.getTime(),
            });
            entries.push({ name, mtime });
          }
          entries.sort(
            (left, right) => right.mtime - left.mtime || left.name.localeCompare(right.name),
          );
          for (const entry of entries.slice(keep))
            yield* fs.remove(path.join(directory, entry.name), { recursive: true, force: true });
          return proceed;
        }),
    });
  const backend: SnapshotBackend = {
    lockFile: options.lockFile,
    entries: path.join(root, "entries"),
    stages: path.join(root, "stages"),
    restoreStages: path.join(instanceRoot, ".supabase-restore"),
    data: path.join(instanceRoot, "data"),
    join: (...parts) => path.join(...parts),
    run: Effect.fnUntraced(function* (steps) {
      for (const current of steps) {
        const stopped = yield* step(current).pipe(
          Effect.mapError((cause) => errorFor(current._tag.toLowerCase(), cause)),
        );
        if (Option.isSome(stopped)) return stopped.value;
      }
      return SnapshotRun.Completed();
    }),
  };
  return backend;
});

/** Wires a native database instance's cache-scoped and instance-scoped snapshot backends. */
export const makeDatabaseSnapshots = Effect.fn("DatabaseSnapshot.make")(function* (options: {
  readonly instanceRoot: string;
  readonly cacheRoot: string;
  readonly runtime: DatabaseRuntime;
  readonly version: string;
}) {
  const path = yield* Path.Path;
  const cache = path.join(options.cacheRoot, "stack-database-snapshots");
  const instance = path.join(options.instanceRoot, instanceSnapshotsDirectory);
  return yield* makeSnapshotStore({
    backends: {
      cache: yield* makeNativeSnapshotBackend({
        instanceRoot: options.instanceRoot,
        root: cache,
        lockFile: path.join(cache, "locks", "native.sqlite"),
      }),
      instance: yield* makeNativeSnapshotBackend({
        instanceRoot: options.instanceRoot,
        root: instance,
        lockFile: path.join(instance, "lock.sqlite"),
      }),
    },
    instanceRoot: options.instanceRoot,
    runtime: options.runtime,
    version: postgresVersion(options.version),
  });
});
