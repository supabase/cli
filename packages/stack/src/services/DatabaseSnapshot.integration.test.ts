import { PgClient } from "@effect/sql-pg";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Data, Effect, FileSystem, Layer, Path, Redacted, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { makeService, ServiceError } from "../Service.ts";
import { makeDatabase, type BackendEndpoint, type DatabaseConfig } from "./Database.ts";
import { SnapshotDescriptor, makeDatabaseSnapshots } from "./DatabaseSnapshot.ts";

class SnapshotTestError extends Data.TaggedError("SnapshotTestError")<{
  readonly message: string;
}> {}

const config: DatabaseConfig = {
  version: "17",
  databasePassword: Redacted.make("supabase-snapshot-source-password"),
  jwtSecret: Redacted.make("supabase-snapshot-jwt-secret"),
  jwtExpiry: 3600,
};

const query = (endpoint: BackendEndpoint, password: Redacted.Redacted<string>, statement: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const host = endpoint.kind === "unix" ? endpoint.path : endpoint.host;
      const services = yield* Layer.build(
        PgClient.layer({
          host,
          port: endpoint.port,
          database: "postgres",
          username: "supabase_admin",
          password,
        }),
      );
      return yield* Context.get(services, PgClient.PgClient).unsafe(statement);
    }),
  );

const storageError = (cause: unknown) =>
  cause instanceof ServiceError
    ? cause
    : new ServiceError({
        operation: "storage",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

const Marker = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.String,
    runtime: Schema.Literals(["native", "docker", "podman"]),
    profile: Schema.Literal("supabase"),
  }),
);

const writeMarker = (
  fs: FileSystem.FileSystem,
  root: string,
  runtime: "native" | "docker" | "podman",
  version = "17.6.1.168",
) =>
  Effect.gen(function* () {
    const marker = yield* Schema.encodeEffect(Marker)({ version, runtime, profile: "supabase" });
    yield* fs.writeFileString(`${root}/.supabase-database-ready.json`, marker, { mode: 0o600 });
  });

const prepareRoot = (
  fs: FileSystem.FileSystem,
  runtime: "native" | "docker" | "podman",
  prefix: string,
) =>
  Effect.gen(function* () {
    const root = yield* fs.makeTempDirectoryScoped({ prefix });
    yield* fs.makeDirectory(`${root}/data`, { recursive: true });
    yield* fs.writeFileString(`${root}/data/PG_VERSION`, "17\n");
    yield* writeMarker(fs, root, runtime);
    return root;
  });

const tar = (args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(ChildProcess.make("tar", args, { stdin: "ignore" }));
      const [stdout, stderr, code] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText, Stream.mkString),
          child.stderr.pipe(Stream.decodeText, Stream.mkString),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (Number(code) !== 0) return yield* new SnapshotTestError({ message: stderr });
      return stdout;
    }),
  );

for (const runtime of ["native", "docker"] as const) {
  it.live(
    `exports and restores SQL data through the ${runtime} database service`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: `snapshot-${runtime}-` });
          const source = yield* makeDatabase({
            stackId: `snapshot-${runtime}`,
            instanceId: "source",
            root,
            cacheRoot: "/tmp/supabase-stack-artifacts",
            runtime,
          });
          const sourceService = yield* makeService(source.definition, {
            id: `database:${runtime}:source`,
            config,
          });
          yield* sourceService.start;
          yield* sourceService.ready;
          yield* query(
            yield* source.endpoint,
            config.databasePassword,
            "CREATE TABLE snapshot_data (value text NOT NULL); INSERT INTO snapshot_data VALUES ('restored-row')",
          );
          yield* sourceService.stop;

          const sourceRoot = path.join(root, "source");
          const sourceSnapshots = yield* makeDatabaseSnapshots({
            instanceRoot: sourceRoot,
            runtime,
            version: config.version,
            stackId: `snapshot-${runtime}`,
            instanceId: "source",
          });
          const archive = path.join(root, `${runtime}.tar`);
          yield* sourceService.storage(
            sourceSnapshots
              .exportSnapshot({ destination: archive })
              .pipe(Effect.mapError(storageError)),
          );

          const target = yield* makeDatabase({
            stackId: `snapshot-${runtime}`,
            instanceId: "target",
            root,
            cacheRoot: "/tmp/supabase-stack-artifacts",
            runtime,
          });
          const targetPassword = Redacted.make(`snapshot-${runtime}-target-password`);
          const targetService = yield* makeService(target.definition, {
            id: `database:${runtime}:target`,
            config: { ...config, databasePassword: targetPassword },
          });
          const targetRoot = path.join(root, "target");
          if (runtime === "native") yield* fs.makeDirectory(path.join(targetRoot, "data"));
          const targetSnapshots = yield* makeDatabaseSnapshots({
            instanceRoot: targetRoot,
            runtime,
            version: config.version,
            stackId: `snapshot-${runtime}`,
            instanceId: "target",
          });
          yield* targetService.storage(
            targetSnapshots
              .restoreSnapshot({ source: archive })
              .pipe(Effect.mapError(storageError)),
          );
          yield* targetService.start;
          yield* targetService.ready;
          const rows = yield* query(
            yield* target.endpoint,
            targetPassword,
            "SELECT value FROM snapshot_data",
          );
          expect(rows).toEqual([{ value: "restored-row" }]);
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 180_000 },
  );
}

it.live("rejects nonempty targets, incompatible versions, and unsafe members", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceRoot = yield* prepareRoot(fs, "native", "snapshot-invalid-source-");
      const destinationRoot = yield* fs.makeTempDirectoryScoped({ prefix: "snapshot-invalid-" });
      const source = yield* makeDatabaseSnapshots({
        instanceRoot: sourceRoot,
        runtime: "native",
        version: "17",
        stackId: "stack",
        instanceId: "source",
      });
      const archive = `${destinationRoot}/baseline.tar`;
      yield* source.exportSnapshot({ destination: archive });

      const nonempty = yield* makeDatabaseSnapshots({
        instanceRoot: yield* prepareRoot(fs, "native", "snapshot-nonempty-"),
        runtime: "native",
        version: "17",
        stackId: "stack",
        instanceId: "nonempty",
      });
      const nonemptyFailure = yield* nonempty
        .restoreSnapshot({ source: archive })
        .pipe(Effect.flip);
      expect(nonemptyFailure.operation).toBe("restore");

      const incompatibleRoot = yield* prepareRoot(fs, "native", "snapshot-version-");
      yield* fs.remove(`${incompatibleRoot}/data/PG_VERSION`);
      yield* writeMarker(fs, incompatibleRoot, "native", "15.14.1.168");
      const incompatible = yield* makeDatabaseSnapshots({
        instanceRoot: incompatibleRoot,
        runtime: "native",
        version: "15",
        stackId: "stack",
        instanceId: "version",
      });
      const versionFailure = yield* incompatible
        .restoreSnapshot({ source: archive })
        .pipe(Effect.flip);
      expect(versionFailure.operation).toBe("descriptor");

      const unsafeSource = yield* prepareRoot(fs, "native", "snapshot-unsafe-source-");
      yield* fs.symlink("/tmp", `${unsafeSource}/data/unsafe-link`);
      const unsafe = yield* makeDatabaseSnapshots({
        instanceRoot: unsafeSource,
        runtime: "native",
        version: "17",
        stackId: "stack",
        instanceId: "unsafe",
      });
      const unsafeArchive = `${destinationRoot}/unsafe.tar`;
      yield* unsafe.exportSnapshot({ destination: unsafeArchive });
      const unsafeTarget = yield* prepareRoot(fs, "native", "snapshot-unsafe-target-");
      yield* fs.remove(`${unsafeTarget}/data/PG_VERSION`);
      const unsafeRestore = yield* makeDatabaseSnapshots({
        instanceRoot: unsafeTarget,
        runtime: "native",
        version: "17",
        stackId: "stack",
        instanceId: "unsafe-target",
      });
      const unsafeFailure = yield* unsafeRestore
        .restoreSnapshot({ source: unsafeArchive })
        .pipe(Effect.flip);
      expect(unsafeFailure.operation).toBe("validate");

      const descriptor = yield* tar(["-xOf", archive, "metadata/descriptor.json"]);
      const malformedRoot = yield* fs.makeTempDirectoryScoped({ prefix: "snapshot-malformed-" });
      yield* fs.makeDirectory(`${malformedRoot}/data`, { recursive: true });
      yield* fs.makeDirectory(`${malformedRoot}/metadata`, { recursive: true });
      yield* fs.writeFileString(`${malformedRoot}/metadata/descriptor.json`, descriptor);
      const malformedArchive = `${destinationRoot}/missing-pg-version.tar`;
      yield* tar(["-cf", malformedArchive, "-C", malformedRoot, "data", "metadata"]);
      const malformedTarget = yield* fs.makeTempDirectoryScoped({
        prefix: "snapshot-malformed-target-",
      });
      yield* fs.makeDirectory(`${malformedTarget}/data`, { recursive: true });
      const malformedStore = yield* makeDatabaseSnapshots({
        instanceRoot: malformedTarget,
        runtime: "native",
        version: "17",
        stackId: "stack",
        instanceId: "malformed",
      });
      const malformedFailure = yield* malformedStore
        .restoreSnapshot({ source: malformedArchive })
        .pipe(Effect.flip);
      expect(malformedFailure.operation).toBe("validate");
      expect(yield* fs.readDirectory(`${malformedTarget}/data`)).toEqual([]);

      yield* fs.writeFileString(`${malformedRoot}/data/PG_VERSION`, "16\n");
      const wrongVersionArchive = `${destinationRoot}/wrong-pg-version.tar`;
      yield* tar(["-cf", wrongVersionArchive, "-C", malformedRoot, "data", "metadata"]);
      const wrongVersionTarget = yield* fs.makeTempDirectoryScoped({
        prefix: "snapshot-wrong-version-target-",
      });
      yield* fs.makeDirectory(`${wrongVersionTarget}/data`, { recursive: true });
      const wrongVersionStore = yield* makeDatabaseSnapshots({
        instanceRoot: wrongVersionTarget,
        runtime: "native",
        version: "17",
        stackId: "stack",
        instanceId: "wrong-version",
      });
      const wrongVersionFailure = yield* wrongVersionStore
        .restoreSnapshot({ source: wrongVersionArchive })
        .pipe(Effect.flip);
      expect(wrongVersionFailure.operation).toBe("validate");
      expect(yield* fs.readDirectory(`${wrongVersionTarget}/data`)).toEqual([]);

      const dockerRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "snapshot-docker-unsafe-source-",
      });
      yield* fs.makeDirectory(`${dockerRoot}/data`, { recursive: true });
      yield* fs.makeDirectory(`${dockerRoot}/metadata`, { recursive: true });
      yield* fs.writeFileString(`${dockerRoot}/data/PG_VERSION`, "17\n");
      yield* fs.symlink("/tmp", `${dockerRoot}/data/unsafe-link`);
      const dockerDescriptor = yield* Schema.encodeEffect(
        Schema.fromJsonString(SnapshotDescriptor),
      )({
        format: "supabase-database-snapshot-v1",
        version: "17.6.1.168",
        runtime: "docker",
        platform: process.platform,
        arch: process.arch,
        profile: "supabase",
      });
      yield* fs.writeFileString(`${dockerRoot}/metadata/descriptor.json`, dockerDescriptor);
      const dockerArchive = `${destinationRoot}/unsafe-docker.tar`;
      yield* tar(["-cf", dockerArchive, "-C", dockerRoot, "data", "metadata"]);
      const dockerTarget = yield* fs.makeTempDirectoryScoped({
        prefix: "snapshot-docker-unsafe-target-",
      });
      yield* fs.makeDirectory(`${dockerTarget}/data`, { recursive: true });
      const dockerStore = yield* makeDatabaseSnapshots({
        instanceRoot: dockerTarget,
        runtime: "docker",
        version: "17",
        stackId: "stack",
        instanceId: "docker-unsafe",
      });
      const dockerFailure = yield* dockerStore
        .restoreSnapshot({ source: dockerArchive })
        .pipe(Effect.flip);
      expect(dockerFailure.operation).toBe("validate");

      const dockerNonemptyRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "snapshot-docker-nonempty-target-",
      });
      yield* fs.makeDirectory(`${dockerNonemptyRoot}/data`, { recursive: true });
      yield* fs.writeFileString(`${dockerNonemptyRoot}/data/sentinel`, "occupied\n");
      const dockerNonemptyStore = yield* makeDatabaseSnapshots({
        instanceRoot: dockerNonemptyRoot,
        runtime: "docker",
        version: "17",
        stackId: "stack",
        instanceId: "docker-nonempty",
      });
      const dockerNonemptyFailure = yield* dockerNonemptyStore
        .restoreSnapshot({ source: archive })
        .pipe(Effect.flip);
      expect(dockerNonemptyFailure.operation).toBe("restore");
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);
