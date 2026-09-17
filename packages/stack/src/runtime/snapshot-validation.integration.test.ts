import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Path, Ref, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { pack, type Headers } from "tar-stream";
import { compileServiceInstance, createExecutionPlan } from "../model/Compiler.ts";
import { deriveStackId } from "../identity/Identity.ts";
import { StackPreparationError, UnsupportedSnapshotError } from "../public/Errors.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import type { StackPaths } from "../state/Paths.ts";
import type { RuntimeDriver } from "./RuntimeDriver.ts";
import { makePostgresInstanceRuntime } from "./PostgresInstanceRuntime.ts";

interface ArchiveEntry {
  readonly name: string;
  readonly contents?: string;
  readonly type?: "file" | "directory";
  readonly pax?: Record<string, string>;
}

const archiveBytes = (entries: ReadonlyArray<ArchiveEntry>) =>
  Effect.callback<Uint8Array, Error>((resume) => {
    const archive = pack();
    const chunks: Buffer[] = [];
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.once("error", (error: Error) => resume(Effect.fail(error)));
    archive.once("end", () => resume(Effect.succeed(Buffer.concat(chunks))));
    for (const entry of entries) {
      const header: Headers & Pick<ArchiveEntry, "pax"> = {
        name: entry.name,
        type: entry.type ?? "file",
        ...(entry.pax === undefined ? {} : { pax: entry.pax }),
        mode: entry.type === "directory" ? 0o700 : 0o600,
      };
      archive.entry(header, entry.contents ?? "");
    }
    archive.finalize();
    return Effect.sync(() => archive.destroy());
  });

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "snapshot-validation-" });
  const identity = { projectRoot: root, branchContext: "test", stackName: "snapshot" };
  const stackId = yield* deriveStackId(identity);
  const runtime = { kind: "native" } as const;
  const compiled = yield* compileServiceInstance(
    { service: "database", config: {} },
    { projectRoot: root, path, runtime },
  );
  const paths: StackPaths = {
    stackRoot: root,
    stateDocument: path.join(root, "state.json"),
    data: path.join(root, "data"),
    logs: path.join(root, "logs"),
    runtime: path.join(root, "runtime"),
    controlMetadata: path.join(root, "control.json"),
  };
  const state: PersistedStackState = {
    format: "supabase-stack-state-v2",
    identity,
    runtime,
    preparation: "on-demand",
    security: {
      jwt: {
        issuer: null,
        expirySeconds: 3600,
        signing: { kind: "symmetric", secret: { slot: "test-jwt" } },
      },
    },
    listeners: {},
    registry: { initialized: true, instances: [compiled.instance], defaultInstanceIds: {} },
    ports: [],
    privatePorts: [],
    secrets: {},
  };
  const plan = yield* createExecutionPlan(runtime, state.registry);
  const driver: RuntimeDriver = {
    observe: () => Effect.die("Snapshot restore must not observe processes"),
    start: () => Effect.die("Snapshot restore must not start processes"),
    stop: () => Effect.die("Snapshot restore must not stop processes"),
    remove: () => Effect.die("Snapshot restore must not remove processes"),
    cleanup: () => Effect.die("Snapshot restore must not clean unrelated resources"),
    wipePersistentData: () => Effect.die("Snapshot restore must not wipe existing data"),
  };
  const publications = yield* Ref.make(0);
  const target = path.join(paths.data, "instances", compiled.id);
  const provider = makePostgresInstanceRuntime({
    runtime,
    paths,
    driver,
    artifactPreparer: { prepare: () => Effect.die("Metadata is already resolved") },
    context: Context.empty().pipe(
      Context.add(FileSystem.FileSystem, fs),
      Context.add(Path.Path, path),
      Context.add(ChildProcessSpawner.ChildProcessSpawner, spawner),
    ),
    snapshotData: {
      exists: () => Effect.succeed(false),
      readVersion: () => Effect.succeed(17),
      restoreTargetEmpty: () =>
        fs.exists(target).pipe(
          Effect.map((exists) => !exists),
          Effect.mapError(
            (cause) => new StackPreparationError({ message: "Target inspection failed", cause }),
          ),
        ),
      export: () => Effect.die("Restore does not export"),
      restore: (_input, source, destination) =>
        fs.copy(source, destination).pipe(
          Effect.andThen(Ref.update(publications, (count) => count + 1)),
          Effect.mapError(
            (cause) => new StackPreparationError({ message: "Publication failed", cause }),
          ),
        ),
      rollbackRestore: () =>
        fs
          .remove(target, { recursive: true, force: true })
          .pipe(
            Effect.mapError(
              (cause) => new StackPreparationError({ message: "Rollback failed", cause }),
            ),
          ),
    },
    snapshotMetadata: () =>
      Effect.succeed({
        artifactIdentity: "test-postgres",
        runtimeIdentity: "test-native",
        majorVersion: 17,
      }),
    reconcileManaged: () => Effect.die("Restore must not reconcile a running database"),
    reconcileCatalogRecipe: () => Effect.die("Restore must not run catalog migrations"),
    publishInitialization: () => Effect.void,
    publishFreshData: () => Effect.die("Restore preserves source lineage"),
    publishIncompleteData: () => Effect.void,
    journal: () => Effect.void,
  });
  const manifest = {
    format: "supabase-postgres-instance-v1",
    majorVersion: 1,
    sourceInstanceId: compiled.id,
    lineageId: "source-lineage",
    profileId: null,
    artifactIdentity: "test-postgres",
    runtimeIdentity: "test-native",
    exportOperationId: "source-export",
    recipes: [],
    dataFormat: { provider: "postgres", format: "pgdata", majorVersion: 17 },
  };
  const restore = (entries: ReadonlyArray<ArchiveEntry>) =>
    Effect.gen(function* () {
      const source = path.join(root, "source.tar");
      const encodedManifest = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        manifest,
      );
      const bytes = yield* archiveBytes([
        { name: "manifest.json", contents: encodedManifest },
        { name: "postgres", type: "directory" },
        ...entries,
      ]);
      yield* fs.writeFile(source, bytes);
      return yield* provider.restoreSnapshot(
        {
          stackId,
          state,
          instance: compiled.instance,
          plan,
          operation: { id: "restore-test", generation: 1 },
        },
        { source },
      );
    });
  return { fs, path, root, target, restore, publications };
});

describe("snapshot validation before storage publication", () => {
  it.live("restores ordinary PAX metadata and long filenames", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const name = `postgres/${"catalog".repeat(25)}`;
        const restored = yield* f.restore([
          { name: "postgres/PG_VERSION", contents: "17\n", pax: { mtime: "1712345678.125" } },
          { name, contents: "catalog payload" },
        ]);
        expect(restored.lineageId).toBe("source-lineage");
        expect(yield* Ref.get(f.publications)).toBe(1);
        expect(yield* f.fs.readFileString(f.path.join(f.target, name))).toBe("catalog payload");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  for (const payload of ["16\n", "not-a-version\n", undefined]) {
    it.live(`rejects PG_VERSION ${JSON.stringify(payload)} before publication`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const error = yield* f
            .restore(
              payload === undefined ? [] : [{ name: "postgres/PG_VERSION", contents: payload }],
            )
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(
            payload === undefined ? StackPreparationError : UnsupportedSnapshotError,
          );
          expect(yield* Ref.get(f.publications)).toBe(0);
          expect(yield* f.fs.exists(f.target)).toBe(false);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  }

  for (const pax of [false, true]) {
    it.live(`rejects an absolute ${pax ? "PAX" : "USTAR"} path containing whitespace`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const outside = f.path.join(f.root, "outside \npostgres", "allowed");
          const error = yield* f
            .restore([
              { name: "postgres/PG_VERSION", contents: "17\n" },
              { name: outside, contents: "escape", ...(pax ? { pax: { path: outside } } : {}) },
            ])
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(StackPreparationError);
          expect(error.message).toBe("Snapshot archive contains an unsafe path");
          expect(yield* Ref.get(f.publications)).toBe(0);
          expect(yield* f.fs.exists(outside)).toBe(false);
          expect(yield* f.fs.exists(f.target)).toBe(false);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  }
});
