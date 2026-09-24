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
import { ChildProcessSpawner } from "effect/unstable/process";
import { postgresVersion } from "../Artifacts.ts";
import { copyDirectory } from "../storage/DirectoryCopy.ts";
import type { DatabaseRuntime } from "./Database.ts";

const SnapshotDescriptor = Schema.Struct({
  format: Schema.Literal("supabase-database-snapshot-v1"),
  version: Schema.String,
  runtime: Schema.Literals(["native", "docker", "podman"]),
  platform: Schema.String,
  arch: Schema.String,
  profile: Schema.Literal("supabase"),
  logicalKey: Schema.String,
  keyDigest: Schema.String,
});

export class DatabaseSnapshotError extends Data.TaggedError("DatabaseSnapshotError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const errorFor = (operation: string, cause: unknown) =>
  cause instanceof DatabaseSnapshotError
    ? cause
    : new DatabaseSnapshotError({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

const ReadyMarker = Schema.Struct({
  version: Schema.String,
  runtime: Schema.Literals(["native", "docker", "podman"]),
  profile: Schema.Literal("supabase"),
});

const markerText = (version: string, runtime: DatabaseRuntime) =>
  Schema.encodeEffect(Schema.fromJsonString(ReadyMarker))({
    version,
    runtime,
    profile: "supabase",
  });

export const makeDatabaseSnapshots = Effect.fn("DatabaseSnapshot.make")(function* (options: {
  readonly instanceRoot: string;
  readonly cacheRoot: string;
  readonly runtime: DatabaseRuntime;
  readonly version: string;
  readonly stackId: string;
  readonly instanceId: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const version = postgresVersion(options.version);
  const root = path.join(options.cacheRoot, "stack-database-snapshots");
  const entries = path.join(root, "entries");
  const stages = path.join(root, "stages");
  const lockFile = path.join(root, ".lock.sqlite");
  const base = {
    format: "supabase-database-snapshot-v1" as const,
    version,
    runtime: options.runtime,
    platform: process.platform,
    arch: process.arch,
    profile: "supabase" as const,
  };
  const mapError = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError((cause) => errorFor(operation, cause)));
  const ensureStore = mapError(
    "storage",
    fs
      .makeDirectory(root, { recursive: true, mode: 0o700 })
      .pipe(Effect.andThen(fs.makeDirectory(entries, { recursive: true, mode: 0o700 }))),
  );

  const withLock = <A>(effect: Effect.Effect<A, DatabaseSnapshotError>) =>
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
              schedule: Schedule.spaced("50 millis").pipe(
                Schedule.upTo({ duration: "120 seconds" }),
              ),
              while: (cause) =>
                Predicate.hasProperty(cause.cause, "errcode") && cause.cause.errcode === 5,
            }),
            Effect.mapError((cause) => errorFor("lock", cause)),
          );
          return yield* effect;
        }),
      (connection) =>
        Effect.try({
          try: () => connection.close(),
          catch: (cause) => errorFor("unlock", cause),
        }),
    );

  const keyDescriptor = (key: string) => ({ ...base, logicalKey: key });
  const digest = (key: string) =>
    Schema.encodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          format: Schema.Literal("supabase-database-snapshot-v1"),
          version: Schema.String,
          runtime: Schema.Literals(["native", "docker", "podman"]),
          platform: Schema.String,
          arch: Schema.String,
          profile: Schema.Literal("supabase"),
          logicalKey: Schema.String,
        }),
      ),
    )(keyDescriptor(key)).pipe(
      Effect.flatMap((encoded) => crypto.digest("SHA-256", new TextEncoder().encode(encoded))),
      Effect.map((bytes) =>
        Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
      ),
      Effect.mapError((cause) => errorFor("key", cause)),
    );

  const copy = (source: string, destination: string) =>
    copyDirectory(source, destination).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.mapError((cause) => errorFor("copy", cause)),
    );

  const readReady = mapError(
    "ready",
    fs
      .readFileString(path.join(options.instanceRoot, ".supabase-database-ready.json"))
      .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ReadyMarker)))),
  );

  const sourceData = Effect.gen(function* () {
    const ready = yield* readReady;
    if (ready.version !== version || ready.runtime !== options.runtime)
      return yield* errorFor("ready", "Database readiness marker does not match the instance");
    const data = path.join(options.instanceRoot, "data");
    if (!(yield* mapError("data", fs.exists(data))))
      return yield* errorFor("data", "Data is absent");
    if (yield* mapError("data", fs.exists(path.join(data, "postmaster.pid"))))
      return yield* errorFor("data", "Database must be stopped before snapshotting");
    const pgVersion = yield* mapError("data", fs.readFileString(path.join(data, "PG_VERSION")));
    if (pgVersion.trim() !== version.split(".")[0])
      return yield* errorFor("data", "Database PostgreSQL major version is incompatible");
    return data;
  });

  const cleanupChildren = (directory: string, predicate: (name: string) => boolean) =>
    Effect.gen(function* () {
      const names = yield* mapError("cleanup", fs.readDirectory(directory));
      for (const name of names) {
        if (predicate(name))
          yield* mapError("cleanup", fs.remove(path.join(directory, name), { recursive: true }));
      }
    });

  const cleanupStaleStages = Effect.gen(function* () {
    yield* cleanupChildren(stages, (name) => name !== "." && name !== "..");
    yield* cleanupChildren(options.instanceRoot, (name) => name.startsWith(".supabase-restore-"));
  });

  const touch = (target: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* mapError("touch", fs.utimes(target, now / 1_000, now / 1_000));
    });

  const retention = (current: string) =>
    Effect.gen(function* () {
      const names = yield* mapError("retention", fs.readDirectory(entries));
      const values: Array<{ readonly name: string; readonly mtime: number }> = [];
      for (const name of names) {
        if (name === current) continue;
        const info = yield* mapError("retention", fs.stat(path.join(entries, name)));
        values.push({
          name,
          mtime: Option.match(info.mtime, {
            onNone: () => 0,
            onSome: (mtime) => mtime.getTime(),
          }),
        });
      }
      values.sort((left, right) => left.mtime - right.mtime || left.name.localeCompare(right.name));
      for (const value of values.slice(0, Math.max(0, values.length - 2)))
        yield* mapError(
          "retention",
          fs.remove(path.join(entries, value.name), { recursive: true }),
        );
    });

  const saveSnapshot = Effect.fn("DatabaseSnapshot.save")(function* (logicalKey: string) {
    const source = yield* sourceData;
    const keyDigest = yield* digest(logicalKey);
    const descriptor = { ...keyDescriptor(logicalKey), keyDigest };
    const encoded = yield* mapError(
      "descriptor",
      Schema.encodeEffect(Schema.fromJsonString(SnapshotDescriptor))(descriptor),
    );
    const target = path.join(entries, keyDigest);
    yield* ensureStore;
    yield* withLock(
      Effect.gen(function* () {
        yield* mapError("storage", fs.makeDirectory(stages, { recursive: true, mode: 0o700 }));
        yield* cleanupStaleStages;
        const token = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError((cause) => errorFor("stage", cause)),
        );
        const stage = path.join(stages, token);
        const retired = path.join(stages, "retired-" + token);
        yield* mapError("stage", fs.makeDirectory(stage, { recursive: true, mode: 0o700 }));
        yield* Effect.acquireUseRelease(
          Effect.succeed(stage),
          () =>
            Effect.gen(function* () {
              yield* copy(source, path.join(stage, "data"));
              yield* mapError(
                "descriptor",
                fs.writeFileString(path.join(stage, "descriptor.json"), encoded, { mode: 0o600 }),
              );
              const hadTarget = yield* mapError("publish", fs.exists(target));
              if (hadTarget) yield* mapError("publish", fs.rename(target, retired));
              const publication = yield* Effect.exit(mapError("publish", fs.rename(stage, target)));
              if (Exit.isFailure(publication)) {
                if (hadTarget) yield* mapError("rollback", fs.rename(retired, target));
                return yield* Effect.failCause(publication.cause);
              }
              yield* mapError("publish", fs.remove(retired, { recursive: true, force: true }));
              yield* touch(target);
              yield* retention(keyDigest);
            }),
          () => mapError("cleanup", fs.remove(stage, { recursive: true, force: true })),
        );
      }),
    );
  });

  const restoreSnapshot = Effect.fn("DatabaseSnapshot.restore")(function* (logicalKey: string) {
    const data = path.join(options.instanceRoot, "data");
    const keyDigest = yield* digest(logicalKey);
    const target = path.join(entries, keyDigest);
    yield* ensureStore;
    return yield* withLock(
      Effect.gen(function* () {
        yield* mapError("storage", fs.makeDirectory(stages, { recursive: true, mode: 0o700 }));
        yield* cleanupStaleStages;
        if (yield* mapError("restore", fs.exists(data))) {
          if ((yield* mapError("restore", fs.readDirectory(data))).length > 0)
            return yield* errorFor("restore", "Restore target data directory must be empty");
        }
        if (!(yield* mapError("restore", fs.exists(target)))) return false;

        const descriptor = yield* mapError(
          "descriptor",
          fs
            .readFileString(path.join(target, "descriptor.json"))
            .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(SnapshotDescriptor)))),
        );
        if (descriptor.keyDigest !== keyDigest || descriptor.logicalKey !== logicalKey)
          return yield* errorFor("descriptor", "Snapshot manifest does not match its key");
        if (
          descriptor.version !== version ||
          descriptor.runtime !== options.runtime ||
          descriptor.platform !== process.platform ||
          descriptor.arch !== process.arch
        )
          return false;

        const token = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError((cause) => errorFor("stage", cause)),
        );
        const stage = path.join(options.instanceRoot, ".supabase-restore-" + token);
        const retired = path.join(options.instanceRoot, ".supabase-restore-retired-" + token);
        const marker = path.join(options.instanceRoot, ".supabase-database-ready.json");
        const retiredMarker = path.join(
          options.instanceRoot,
          ".supabase-restore-retired-marker-" + token,
        );
        const stagedMarker = path.join(stage, "ready.json");
        yield* mapError("stage", fs.makeDirectory(stage, { recursive: true, mode: 0o700 }));
        yield* Effect.acquireUseRelease(
          Effect.succeed(stage),
          () =>
            Effect.gen(function* () {
              yield* copy(path.join(target, "data"), path.join(stage, "data"));
              const stagedData = path.join(stage, "data");
              const stagedVersion = yield* mapError(
                "validate",
                fs.readFileString(path.join(stagedData, "PG_VERSION")),
              );
              if (stagedVersion.trim() !== version.split(".")[0])
                return yield* errorFor(
                  "validate",
                  "Snapshot PostgreSQL major version is incompatible",
                );
              if (yield* mapError("validate", fs.exists(path.join(stagedData, "postmaster.pid"))))
                return yield* errorFor("validate", "Snapshot contains a running database");
              const markerContents = yield* markerText(version, options.runtime).pipe(
                Effect.mapError((cause) => errorFor("ready", cause)),
              );
              yield* mapError(
                "ready",
                fs.writeFileString(stagedMarker, markerContents, { mode: 0o600 }),
              );

              // The handoff is short and uninterruptible. If marker publication fails, the old
              // complete data tree and marker are restored before the error escapes.
              yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  const hadData = yield* mapError("publish", fs.exists(data));
                  const hadMarker = yield* mapError("publish", fs.exists(marker));
                  if (hadData) yield* mapError("publish", fs.rename(data, retired));
                  const dataPublication = yield* Effect.exit(
                    mapError("publish", fs.rename(path.join(stage, "data"), data)),
                  );
                  if (Exit.isFailure(dataPublication)) {
                    if (hadData) yield* mapError("rollback", fs.rename(retired, data));
                    return yield* Effect.failCause(dataPublication.cause);
                  }
                  if (hadMarker) {
                    const markerRetirement = yield* Effect.exit(
                      mapError("publish", fs.rename(marker, retiredMarker)),
                    );
                    if (Exit.isFailure(markerRetirement)) {
                      yield* mapError(
                        "rollback",
                        fs.remove(data, { recursive: true, force: true }),
                      );
                      if (hadData) yield* mapError("rollback", fs.rename(retired, data));
                      return yield* Effect.failCause(markerRetirement.cause);
                    }
                  }
                  const markerPublication = yield* Effect.exit(
                    mapError("ready", fs.rename(stagedMarker, marker)),
                  );
                  if (Exit.isFailure(markerPublication)) {
                    if (hadMarker) yield* mapError("rollback", fs.rename(retiredMarker, marker));
                    yield* mapError("rollback", fs.remove(data, { recursive: true, force: true }));
                    if (hadData) yield* mapError("rollback", fs.rename(retired, data));
                    return yield* Effect.failCause(markerPublication.cause);
                  }
                  yield* mapError("publish", fs.remove(retired, { recursive: true, force: true }));
                  if (hadMarker)
                    yield* mapError("publish", fs.remove(retiredMarker, { force: true }));
                }),
              );
              yield* touch(target);
            }),
          () => mapError("cleanup", fs.remove(stage, { recursive: true, force: true })),
        );
        return true;
      }),
    );
  });

  return { saveSnapshot, restoreSnapshot };
});
