import {
  Cause,
  Context,
  Effect,
  Exit,
  FileSystem,
  Path,
  PlatformError,
  Option,
  Predicate,
  Schema,
  Stream,
} from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- tar-stream consumes a Node Readable.
import { createReadStream } from "node:fs";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { extract } from "tar-stream";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import type {
  ServiceInitializationEvidence,
  ServiceInitializationInputs,
} from "../model/ServiceRegistry.ts";
import type { PersistedPendingOperation } from "../model/ServiceRegistry.ts";
import type { InstanceRuntimeInput } from "../supervisor/Lifecycle.ts";
import type { BackendEndpoint } from "../gateway/Gateway.ts";
import type { SnapshotDescriptor } from "../public/Service.ts";
import { ServiceKindSchema } from "../public/Service.ts";
import { ServiceInstanceIdSchema } from "../public/ServiceInstanceId.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import type { StackError } from "../public/Errors.ts";
import {
  NoSnapshotDataError,
  InitializationMismatchError,
  SnapshotTargetInvalidError,
  StackPreparationError,
  StackCleanupError,
  StackRuntimeError,
  UnsupportedSnapshotError,
  isStackError,
} from "../public/Errors.ts";
import type { StackPaths } from "../state/Paths.ts";
import type { RuntimeDriver, RuntimeWorkloadKey } from "./RuntimeDriver.ts";
import type { RuntimeBindingPublication } from "./RuntimeBinding.ts";
import type { PreparedWorkloadArtifact } from "../preparation/RuntimeArtifacts.ts";

const DATABASE_CAPABILITY = "database" as const;
const DATABASE_BINDING = "sql:internal";
const ARCHIVE_FORMAT = "supabase-postgres-instance-v1";
const ARCHIVE_MAJOR = 1;
const MANIFEST_NAME = "manifest.json";

const InstanceManifestSchema = Schema.Struct({
  format: Schema.Literal(ARCHIVE_FORMAT),
  majorVersion: Schema.Literal(ARCHIVE_MAJOR),
  sourceInstanceId: ServiceInstanceIdSchema,
  lineageId: Schema.String,
  profileId: Schema.NullOr(Schema.String),
  artifactIdentity: Schema.String,
  runtimeIdentity: Schema.String,
  exportOperationId: Schema.String,
  recipes: Schema.Array(
    Schema.Struct({
      service: ServiceKindSchema,
      recipeId: Schema.String,
      artifactIdentity: Schema.String,
      completed: Schema.Boolean,
    }),
  ),
  dataFormat: Schema.Struct({
    provider: Schema.Literal("postgres"),
    format: Schema.String,
    majorVersion: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  }),
});
type InstanceManifest = Schema.Schema.Type<typeof InstanceManifestSchema>;

export interface CatalogInitializationRecipe {
  readonly service: keyof ServiceInitializationInputs["catalog"];
  readonly recipeId: string;
  readonly version: string;
  readonly settings: unknown;
}

export interface CatalogInitializationResult {
  readonly artifactIdentity: string;
}

interface PostgresSnapshotMetadata {
  readonly artifactIdentity: string;
  readonly runtimeIdentity: string;
  readonly majorVersion: number;
}

interface PostgresArtifactPreparer {
  readonly prepare: (
    runtime: StackRuntime,
    workload: PlannedWorkload,
  ) => Effect.Effect<PreparedWorkloadArtifact, StackError>;
}

export interface PostgresInstanceRuntimeOptions {
  readonly runtime: StackRuntime;
  readonly paths: StackPaths;
  readonly driver: RuntimeDriver;
  readonly artifactPreparer: PostgresArtifactPreparer;
  readonly context: Context.Context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >;
  /** Archives the exact native PGDATA or container volume to the supplied staging directory. */
  readonly snapshotData: {
    /** Confirms that the exact instance data store exists before export. */
    readonly exists: (input: InstanceRuntimeInput) => Effect.Effect<boolean, StackError>;
    /** Reads the PostgreSQL major version from the exact runtime-owned data store. */
    readonly readVersion: (input: InstanceRuntimeInput) => Effect.Effect<number, StackError>;
    /** Confirms that restore will publish into an empty exact instance data store. */
    readonly restoreTargetEmpty: (
      input: InstanceRuntimeInput,
    ) => Effect.Effect<boolean, StackError>;
    readonly export: (
      input: InstanceRuntimeInput,
      destination: string,
    ) => Effect.Effect<void, StackError>;
    /** Must create the target parent, publish atomically, and leave it absent on failure. */
    readonly restore: (
      input: InstanceRuntimeInput,
      source: string,
      destination: string,
    ) => Effect.Effect<void, StackError>;
    /** Removes a newly published restore target after a later publication step fails. */
    readonly rollbackRestore: (input: InstanceRuntimeInput) => Effect.Effect<void, StackError>;
  };
  /** Supplies the concrete resolved artifact/runtime identity persisted in snapshot metadata. */
  readonly snapshotMetadata: (
    input: InstanceRuntimeInput,
    workload: PlannedWorkload,
  ) => Effect.Effect<PostgresSnapshotMetadata, StackError>;
  /** Applies the managed Postgres roles/settings after the private endpoint is ready. */
  readonly reconcileManaged: (
    input: InstanceRuntimeInput,
    endpoint: BackendEndpoint,
    workload: PlannedWorkload,
    artifact: PreparedWorkloadArtifact,
  ) => Effect.Effect<void, StackError>;
  /** Applies one catalog recipe to the exact database instance being started. */
  readonly reconcileCatalogRecipe: (
    input: InstanceRuntimeInput,
    recipe: CatalogInitializationRecipe,
    endpoint: BackendEndpoint,
  ) => Effect.Effect<CatalogInitializationResult, StackError>;
  /** Publishes the completed same-profile receipt in the owning state transaction. */
  readonly publishInitialization: (
    input: InstanceRuntimeInput,
    evidence: ServiceInitializationEvidence,
  ) => Effect.Effect<void, StackError>;
  /** Publishes a fresh-data lineage after the first successful database start. */
  readonly publishFreshData: (
    input: InstanceRuntimeInput,
    lineageId: string,
  ) => Effect.Effect<void, StackError>;
  /** Publishes an operation-scoped incomplete-data marker before storage mutation. */
  readonly publishIncompleteData: (input: InstanceRuntimeInput) => Effect.Effect<void, StackError>;
  /** Publishes absent data after the runtime proves a failed mutation left no target data. */
  readonly publishAbsentData: (input: InstanceRuntimeInput) => Effect.Effect<void, StackError>;
  /** Journals helper/staging ownership before any snapshot helper is started. */
  readonly journal: (
    input: InstanceRuntimeInput,
    phase: "admitted" | "running" | "settling" | "cleanup" | "complete",
    patch?: Readonly<{
      readonly stagingPath?: string;
      readonly outputPath?: string;
      readonly helperId?: string;
    }>,
  ) => Effect.Effect<void, StackError>;
}

const missingWorkload = (input: InstanceRuntimeInput): StackRuntimeError =>
  new StackRuntimeError({
    message: `Database workload for instance ${input.instance.id} is missing from the execution plan`,
    stackId: input.stackId,
    workloadId: input.instance.id,
  });

const keyFor = (input: InstanceRuntimeInput, workload: PlannedWorkload): RuntimeWorkloadKey => ({
  stackId: input.stackId,
  instanceId: input.instance.id,
  workloadId: workload.id,
});

const instanceRecipes = (
  inputs: ServiceInitializationInputs | null,
): ReadonlyArray<CatalogInitializationRecipe> => {
  if (inputs === null) return [];
  type CatalogService = keyof ServiceInitializationInputs["catalog"];
  const services: ReadonlyArray<CatalogService> = [
    "auth",
    "storage",
    "realtime",
    "analytics",
    "pooler",
  ];
  return services.flatMap((service) => {
    const recipe = inputs.catalog[service];
    return recipe === undefined
      ? []
      : [
          {
            service,
            recipeId: `${service}:${recipe.version}`,
            version: recipe.version,
            settings: recipe.settings,
          },
        ];
  });
};

const privateEndpoint = (
  input: InstanceRuntimeInput,
  workload: PlannedWorkload,
): BackendEndpoint | undefined => {
  const assignment = input.state.privatePorts.find(
    (entry) =>
      entry.instanceId === input.instance.id &&
      entry.workloadId === workload.id &&
      entry.binding === DATABASE_BINDING,
  );
  return assignment === undefined ? undefined : { host: "127.0.0.1", port: assignment.port };
};

const archiveError = (message: string, cause?: unknown): StackPreparationError =>
  new StackPreparationError({ message, ...(cause === undefined ? {} : { cause }) });

const stackError = (cause: unknown): StackError =>
  isStackError(cause)
    ? cause
    : new StackRuntimeError({
        message: cause instanceof Error ? cause.message : "PostgreSQL instance runtime failed",
        cause,
      });

const cleanupError = (cause: unknown): StackCleanupError =>
  new StackCleanupError({
    message: cause instanceof Error ? cause.message : "PostgreSQL instance cleanup failed",
    cause,
  });

const runTar = (
  args: ReadonlyArray<string>,
): Effect.Effect<
  void,
  StackPreparationError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make("tar", args, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { COPYFILE_DISABLE: "1" },
        extendEnv: true,
      }).pipe(
        Effect.mapError((cause) => archiveError("Unable to start snapshot archive helper", cause)),
      );
      const drain = Effect.all([Stream.runDrain(handle.stdout), Stream.runDrain(handle.stderr)], {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.mapError((cause) => archiveError("Snapshot archive output failed", cause)));
      const [exitCode] = yield* Effect.all([handle.exitCode, drain], {
        concurrency: "unbounded",
      }).pipe(Effect.mapError((cause) => archiveError("Snapshot archive helper failed", cause)));
      if (Number(exitCode) !== 0)
        return yield* archiveError(`Snapshot archive helper exited with ${String(exitCode)}`);
    }),
  );

const inspectArchive = (
  source: string,
): Effect.Effect<ReadonlyArray<string>, StackPreparationError> =>
  Effect.callback<ReadonlyArray<string>, StackPreparationError>((resume, signal) => {
    const archive = extract();
    const input = createReadStream(source);
    const paths: string[] = [];
    let settled = false;
    const onAbort = () => {
      input.destroy();
      archive.destroy();
    };
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      input.destroy();
      archive.destroy();
      resume(
        Effect.fail(
          archiveError(
            cause instanceof Error ? cause.message : "Unable to inspect snapshot archive",
            cause,
          ),
        ),
      );
    };
    const validate = (name: string, type: string | null | undefined) => {
      if (name.length === 0 || name.includes("\\"))
        throw new Error("Snapshot archive contains an invalid path");
      const isAppleDouble = name === "._manifest.json" || name.startsWith("postgres/._");
      if (
        name.startsWith("/") ||
        name
          .split("/")
          .some(
            (part, index, parts) =>
              part === ".." || (part.length === 0 && index < parts.length - 1),
          ) ||
        (!isAppleDouble &&
          name !== MANIFEST_NAME &&
          name !== "postgres" &&
          !name.startsWith("postgres/"))
      )
        throw new Error("Snapshot archive contains an unsafe path");
      if (type !== "file" && type !== "directory")
        throw new Error("Snapshot archive contains an unsupported link or special file");
    };
    archive.on("entry", (header, entry, next) => {
      try {
        validate(header.name, header.type);
        paths.push(header.name);
        entry.once("error", fail);
        entry.once("end", next);
        entry.resume();
      } catch (cause) {
        archive.destroy();
        fail(cause);
      }
    });
    archive.once("error", fail);
    archive.once("finish", () => {
      if (settled) return;
      settled = true;
      resume(Effect.succeed(paths));
    });
    input.once("error", fail);
    input.pipe(archive);
    signal.addEventListener("abort", onAbort);
    return Effect.sync(() => {
      signal.removeEventListener("abort", onAbort);
      input.destroy();
      archive.destroy();
    });
  });

const readManifest = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  archiveRoot: string,
): Effect.Effect<InstanceManifest, StackPreparationError> =>
  fs.readFileString(path.join(archiveRoot, MANIFEST_NAME)).pipe(
    Effect.mapError((cause) => archiveError("Snapshot manifest is missing", cause)),
    Effect.flatMap((contents) =>
      Schema.decodeEffect(Schema.fromJsonString(InstanceManifestSchema))(contents).pipe(
        Effect.mapError(() => archiveError("Snapshot manifest is invalid")),
      ),
    ),
  );

const destinationParent = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  destination: string,
): Effect.Effect<void, SnapshotTargetInvalidError> =>
  fs.makeDirectory(path.dirname(destination), { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new SnapshotTargetInvalidError({
          message: "Unable to create snapshot destination directory",
          path: destination,
          cause,
        }),
    ),
  );

/** Shared per-instance PostgreSQL lifecycle and snapshot implementation for native and containers. */
export const makePostgresInstanceRuntime = (
  options: PostgresInstanceRuntimeOptions,
): {
  readonly start: (
    input: InstanceRuntimeInput,
  ) => Effect.Effect<ReadonlyArray<RuntimeBindingPublication>, StackError | StackPreparationError>;
  readonly stop: (input: InstanceRuntimeInput) => Effect.Effect<void, StackError>;
  readonly destroy: (input: InstanceRuntimeInput) => Effect.Effect<void, StackError>;
  readonly exportSnapshot: (
    input: InstanceRuntimeInput,
    options: { readonly destination: string },
  ) => Effect.Effect<
    SnapshotDescriptor,
    StackError | StackPreparationError | SnapshotTargetInvalidError
  >;
  readonly restoreSnapshot: (
    input: InstanceRuntimeInput,
    options: { readonly source: string },
  ) => Effect.Effect<SnapshotDescriptor, StackError | StackPreparationError>;
  readonly recoverSnapshot: (
    input: InstanceRuntimeInput,
    operation: PersistedPendingOperation,
  ) => Effect.Effect<SnapshotDescriptor | undefined, StackError>;
} => {
  const provideContext = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >,
  ): Effect.Effect<A, E> => effect.pipe(Effect.provideContext(options.context));

  const workloadFor = (
    input: InstanceRuntimeInput,
  ): Effect.Effect<PlannedWorkload, StackRuntimeError> => {
    const workload = input.plan.workloads.find(
      (entry) => entry.instanceId === input.instance.id && entry.capability === DATABASE_CAPABILITY,
    );
    return workload === undefined ? Effect.fail(missingWorkload(input)) : Effect.succeed(workload);
  };

  const start = (input: InstanceRuntimeInput) =>
    provideContext(
      Effect.suspend(() => {
        let started = false;
        let cleanupKey: RuntimeWorkloadKey | undefined;
        return Effect.gen(function* () {
          const result = yield* Effect.exit(
            Effect.gen(function* () {
              const workload = yield* workloadFor(input);
              const key = keyFor(input, workload);
              cleanupKey = key;
              const artifact = yield* options.artifactPreparer.prepare(options.runtime, workload);
              const endpoint = privateEndpoint(input, workload);
              if (endpoint === undefined)
                return yield* new StackRuntimeError({
                  message: `Private database port for instance ${input.instance.id} is missing`,
                  stackId: input.stackId,
                  workloadId: workload.id,
                });
              const initialization = input.instance.initializationInputs;
              if (
                initialization !== null &&
                input.instance.initialization?.profileId !== undefined &&
                input.instance.initialization.profileId !== initialization.profileId
              )
                return yield* new InitializationMismatchError({
                  instanceId: input.instance.id,
                  profileId: initialization.profileId,
                  message: "Database initialization profile does not match durable receipts",
                });
              if (
                input.instance.data.origin === "absent" ||
                input.instance.data.origin === "incomplete"
              )
                yield* options.publishIncompleteData(input);
              yield* options.driver.start(key, workload);
              started = true;
              yield* journal(options, input, "running");
              yield* options.reconcileManaged(input, endpoint, workload, artifact);
              const receipts: ServiceInitializationEvidence["recipes"][number][] = [];
              const prior =
                initialization !== null &&
                input.instance.initialization?.profileId === initialization.profileId
                  ? (input.instance.initialization?.recipes ?? []).filter(
                      (recipe) => recipe.completed,
                    )
                  : [];
              receipts.push(...prior);
              const completed = new Set(prior.map((recipe) => recipe.recipeId));
              for (const recipe of instanceRecipes(input.instance.initializationInputs)) {
                if (completed.has(recipe.recipeId)) continue;
                const result = yield* options.reconcileCatalogRecipe(input, recipe, endpoint);
                receipts.push({
                  service: recipe.service,
                  recipeId: recipe.recipeId,
                  artifactIdentity: result.artifactIdentity,
                  completed: true,
                });
                if (input.instance.initializationInputs !== null)
                  yield* options.publishInitialization(input, {
                    profileId: input.instance.initializationInputs.profileId,
                    recipes: receipts,
                  });
              }
              if (input.instance.initializationInputs !== null) {
                yield* options.publishInitialization(input, {
                  profileId: input.instance.initializationInputs.profileId,
                  recipes: receipts,
                });
              }
              if (
                input.instance.data.origin === "absent" ||
                input.instance.data.origin === "incomplete"
              )
                yield* options.publishFreshData(input, input.operation.id);
              yield* journal(options, input, "complete");
              return [
                {
                  workloadId: workload.id,
                  recipeId: workload.recipeId,
                  binding: DATABASE_BINDING,
                  endpoint,
                } satisfies RuntimeBindingPublication,
              ];
            }).pipe(Effect.mapError(stackError)),
          );
          if (started && Exit.isFailure(result) && cleanupKey !== undefined) {
            const cleanupResult = yield* Effect.exit(
              options.driver
                .stop(cleanupKey)
                .pipe(
                  Effect.andThen(options.driver.remove(cleanupKey)),
                  Effect.mapError(stackError),
                ),
            );
            if (Exit.isFailure(cleanupResult))
              return yield* cleanupError({ operation: result.cause, cleanup: cleanupResult.cause });
          }
          return yield* result;
        });
      }).pipe(Effect.mapError(stackError)),
    );

  const stop = (input: InstanceRuntimeInput) =>
    provideContext(
      Effect.gen(function* () {
        const workload = yield* workloadFor(input);
        yield* options.driver.stop(keyFor(input, workload));
      }).pipe(Effect.mapError(stackError)),
    );

  const destroy = (input: InstanceRuntimeInput) =>
    provideContext(
      Effect.gen(function* () {
        const workload = yield* workloadFor(input);
        const key = keyFor(input, workload);
        const stopped = yield* Effect.exit(options.driver.stop(key));
        const removed = yield* Effect.exit(options.driver.remove(key));
        const wiped = yield* Effect.exit(options.driver.wipePersistentData(key));
        const failures = [stopped, removed, wiped].flatMap((result) =>
          Exit.isFailure(result) ? [result.cause] : [],
        );
        if (failures.length > 0) return yield* cleanupError(failures);
      }).pipe(Effect.mapError(stackError)),
    );

  const exportSnapshot = (
    input: InstanceRuntimeInput,
    snapshot: { readonly destination: string },
  ) => {
    const destination = snapshot.destination;
    return provideContext(
      Effect.suspend(() => {
        let ownsStage = false;
        const operation = Effect.gen(function* () {
          const workload = yield* workloadFor(input);
          const instancePaths = yield* resolvePaths(options.paths, input.instance.id);
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          if (!(yield* options.snapshotData.exists(input)))
            return yield* new NoSnapshotDataError({
              message: "PostgreSQL instance data is absent",
              instanceId: input.instance.id,
            });
          if (yield* fs.exists(destination))
            return yield* new SnapshotTargetInvalidError({
              message: "Snapshot destination already exists",
              path: destination,
            });
          const metadata = yield* options.snapshotMetadata(input, workload);
          const manifest = yield* manifestFor(input, undefined, metadata);
          const staging = path.join(instancePaths.snapshotStaging, `export-${input.operation.id}`);
          const stagedArchive = `${destination}.stage.${input.operation.id}`;
          const stageClaim = `${stagedArchive}.claim`;
          if (yield* fs.exists(stagedArchive))
            return yield* new SnapshotTargetInvalidError({
              message: "Snapshot staging destination already exists",
              path: stagedArchive,
            });
          if (yield* fs.exists(stageClaim))
            return yield* new SnapshotTargetInvalidError({
              message: "Snapshot staging claim already exists",
              path: stageClaim,
            });
          yield* destinationParent(fs, path, destination);
          yield* fs.writeFileString(stageClaim, "", { flag: "wx", mode: 0o600 }).pipe(
            Effect.mapError(
              (cause) =>
                new SnapshotTargetInvalidError({
                  message: "Unable to claim snapshot staging destination",
                  path: stageClaim,
                  cause,
                }),
            ),
          );
          ownsStage = true;
          yield* journal(options, input, "admitted", {
            stagingPath: stagedArchive,
            outputPath: destination,
            helperId: `tar-export-${input.operation.id}`,
          });
          yield* fs
            .makeDirectory(path.join(staging, "postgres"), { recursive: true, mode: 0o700 })
            .pipe(
              Effect.mapError((cause) =>
                archiveError("Unable to create snapshot staging directory", cause),
              ),
            );
          const encodedManifest = yield* encodeManifest(manifest);
          yield* fs
            .writeFileString(path.join(staging, MANIFEST_NAME), encodedManifest)
            .pipe(
              Effect.mapError((cause) => archiveError("Unable to write snapshot manifest", cause)),
            );
          yield* options.snapshotData.export(input, path.join(staging, "postgres"));
          yield* runTar(["-C", staging, "-cf", stagedArchive, MANIFEST_NAME, "postgres"]);
          yield* fs.link(stagedArchive, destination).pipe(
            Effect.mapError(
              (cause) =>
                new SnapshotTargetInvalidError({
                  message: "Unable to publish snapshot archive atomically",
                  path: destination,
                  cause,
                }),
            ),
          );
          return descriptorFor(manifest);
        });
        return withCleanup<StackError>(() =>
          ownsStage
            ? cleanupStaging(
                options,
                input,
                "export",
                `${destination}.stage.${input.operation.id}`,
                `${destination}.stage.${input.operation.id}.claim`,
              )
            : Effect.void,
        )(operation.pipe(Effect.mapError(stackError))).pipe(
          Effect.flatMap((descriptor) =>
            journal(options, input, "complete").pipe(
              Effect.mapError((cause) => cleanupError(cause)),
              Effect.as(descriptor),
            ),
          ),
          Effect.mapError(stackError),
        );
      }),
    );
  };

  const settleFailedRestore = (input: InstanceRuntimeInput, cause: Cause.Cause<StackError>) =>
    Effect.gen(function* () {
      const restoreError = Cause.findErrorOption(cause);
      if (
        Cause.hasDies(cause) ||
        Cause.hasInterrupts(cause) ||
        Option.isNone(restoreError) ||
        restoreError.value instanceof StackCleanupError
      )
        return yield* Effect.failCause(cause);
      const targetEmpty = yield* Effect.exit(options.snapshotData.restoreTargetEmpty(input));
      if (Exit.isFailure(targetEmpty))
        return yield* Effect.failCause(
          Cause.combine(
            Cause.fail(
              new StackCleanupError({ message: "Unable to prove failed restore target cleanup" }),
            ),
            Cause.combine(cause, targetEmpty.cause),
          ),
        );
      if (!targetEmpty.value)
        return yield* Effect.failCause(
          Cause.combine(
            Cause.fail(new StackCleanupError({ message: "Failed restore target is not empty" })),
            cause,
          ),
        );
      const absent = yield* Effect.exit(options.publishAbsentData(input));
      if (Exit.isFailure(absent))
        return yield* Effect.failCause(
          Cause.combine(
            Cause.fail(
              new StackCleanupError({ message: "Unable to publish absent restore data state" }),
            ),
            Cause.combine(cause, absent.cause),
          ),
        );
      return yield* Effect.failCause(cause);
    });

  const restoreSnapshot = (input: InstanceRuntimeInput, snapshot: { readonly source: string }) => {
    return provideContext(
      Effect.suspend(() => {
        let ownsStaging = false;
        const operation = Effect.gen(function* () {
          const workload = yield* workloadFor(input);
          const source = snapshot.source;
          const instancePaths = yield* resolvePaths(options.paths, input.instance.id);
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          if (!(yield* fs.exists(source)))
            return yield* new NoSnapshotDataError({
              message: "Snapshot source is absent",
              instanceId: input.instance.id,
            });
          if (!(yield* options.snapshotData.restoreTargetEmpty(input)))
            return yield* new SnapshotTargetInvalidError({
              message: "Snapshot restore target is not empty",
              path: instancePaths.data,
            });
          const staging = path.join(instancePaths.snapshotStaging, `restore-${input.operation.id}`);
          if (yield* fs.exists(staging))
            return yield* new SnapshotTargetInvalidError({
              message: "Snapshot restore staging directory already exists",
              path: staging,
            });
          yield* journal(options, input, "admitted", {
            stagingPath: staging,
            helperId: `tar-restore-${input.operation.id}`,
          });
          yield* fs
            .makeDirectory(staging, { recursive: true, mode: 0o700 })
            .pipe(
              Effect.mapError((cause) =>
                archiveError("Unable to create restore staging directory", cause),
              ),
            );
          ownsStaging = true;
          const archiveEntries = yield* inspectArchive(source);
          if (
            !archiveEntries.includes(MANIFEST_NAME) ||
            (!archiveEntries.includes("postgres") && !archiveEntries.includes("postgres/"))
          )
            return yield* archiveError("Snapshot archive is incomplete");
          yield* runTar(["-xf", source, "-C", staging, "--no-same-owner"]);
          const manifest = yield* readManifest(fs, path, staging);
          const pgVersion = yield* fs
            .readFileString(path.join(staging, "postgres", "PG_VERSION"))
            .pipe(Effect.mapError(() => archiveError("Snapshot PostgreSQL version is missing")));
          const expectedProfile = input.instance.initializationInputs?.profileId ?? null;
          const metadata = yield* options.snapshotMetadata(input, workload);
          if (manifest.profileId !== expectedProfile)
            return yield* new InitializationMismatchError({
              instanceId: input.instance.id,
              profileId: expectedProfile ?? "none",
              message: "Snapshot initialization profile does not match the target instance",
            });
          if (
            manifest.dataFormat.provider !== "postgres" ||
            manifest.majorVersion !== ARCHIVE_MAJOR ||
            manifest.dataFormat.format !== "pgdata" ||
            manifest.dataFormat.majorVersion !== metadata.majorVersion ||
            manifest.artifactIdentity !== metadata.artifactIdentity ||
            manifest.runtimeIdentity !== metadata.runtimeIdentity ||
            pgVersion.trim() !== String(metadata.majorVersion)
          )
            return yield* new UnsupportedSnapshotError({
              message: "Snapshot format is unsupported",
              instanceId: input.instance.id,
            });
          yield* fs
            .makeDirectory(path.dirname(instancePaths.manifest), { recursive: true, mode: 0o700 })
            .pipe(
              Effect.mapError((cause) =>
                archiveError("Unable to create instance manifest directory", cause),
              ),
            );
          yield* options.publishIncompleteData(input);
          const restored = yield* Effect.exit(
            options.snapshotData.restore(
              input,
              path.join(staging, "postgres"),
              instancePaths.postgresData,
            ),
          );
          if (Exit.isFailure(restored)) {
            return yield* settleFailedRestore(input, restored.cause);
          }
          // A settling journal proves the restore helper published this operation's target. If
          // the owner dies before the manifest receipt is committed, recovery may roll back
          // that exact target through the driver's ownership-aware hook.
          const settling = yield* Effect.exit(journal(options, input, "settling"));
          if (Exit.isFailure(settling))
            return yield* new StackCleanupError({
              message: "Unable to journal restored PostgreSQL data publication",
              cause: settling.cause,
            });
          const encoded = yield* Effect.exit(encodeManifest(manifest));
          if (Exit.isFailure(encoded))
            return yield* new StackCleanupError({
              message: "Unable to encode restored PostgreSQL manifest",
              cause: encoded.cause,
            });
          const encodedManifest = encoded.value;
          const published = yield* Effect.exit(
            fs
              .writeFileString(instancePaths.manifest, encodedManifest)
              .pipe(
                Effect.mapError((cause) =>
                  archiveError("Unable to publish instance manifest", cause),
                ),
              ),
          );
          if (Exit.isFailure(published)) {
            const rollback = yield* Effect.exit(options.snapshotData.rollbackRestore(input));
            if (Exit.isFailure(rollback))
              return yield* cleanupError({ operation: published.cause, cleanup: rollback.cause });
            return yield* settleFailedRestore(input, published.cause);
          }
          if (manifest.profileId !== null && manifest.recipes.length > 0) {
            const initialized = yield* Effect.exit(
              options.publishInitialization(input, {
                profileId: manifest.profileId,
                recipes: manifest.recipes,
              }),
            );
            if (Exit.isFailure(initialized))
              return yield* new StackCleanupError({
                message: "Unable to publish restored initialization evidence",
                cause: initialized.cause,
              });
          }
          return descriptorFor(manifest);
        });
        return withCleanup<StackError>(() =>
          ownsStaging ? cleanupStaging(options, input, "restore") : Effect.void,
        )(
          operation.pipe(
            Effect.catchCause((cause) => Effect.failCause(Cause.map(cause, stackError))),
          ),
        ).pipe(
          Effect.flatMap((descriptor) =>
            journal(options, input, "complete").pipe(
              Effect.mapError((cause) => cleanupError(cause)),
              Effect.as(descriptor),
            ),
          ),
          Effect.catchCause((cause) => Effect.failCause(Cause.map(cause, stackError))),
        );
      }),
    );
  };

  const recoverSnapshot = (
    input: InstanceRuntimeInput,
    operation: PersistedPendingOperation,
  ): Effect.Effect<SnapshotDescriptor | undefined, StackError> =>
    provideContext(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const instancePaths = yield* resolvePaths(options.paths, input.instance.id);
        const expectedStaging = path.join(
          instancePaths.snapshotStaging,
          `${operation.kind === "exportSnapshot" ? "export" : "restore"}-${operation.id}`,
        );
        const expectedArchive =
          operation.kind === "exportSnapshot" && operation.outputPath !== undefined
            ? `${operation.outputPath}.stage.${operation.id}`
            : undefined;
        const recoveryFence = (message: string) =>
          new StackRuntimeError({
            message,
            stackId: input.stackId,
            workloadId: input.instance.id,
          });
        if (
          operation.stagingPath !== undefined &&
          operation.stagingPath !== expectedStaging &&
          operation.stagingPath !== expectedArchive
        )
          return yield* recoveryFence(
            `Snapshot operation ${operation.id} has an unexpected staging path; refusing recovery`,
          );

        const cleanup = () =>
          cleanupStaging(
            options,
            input,
            operation.kind === "exportSnapshot" ? "export" : "restore",
            operation.kind === "exportSnapshot"
              ? (expectedArchive ?? operation.stagingPath)
              : undefined,
            expectedArchive === undefined ? undefined : `${expectedArchive}.claim`,
          );

        if (operation.kind === "exportSnapshot") {
          if (operation.outputPath === undefined || !(yield* fs.exists(operation.outputPath))) {
            if (operation.phase === "complete")
              return yield* recoveryFence(
                `Snapshot operation ${operation.id} has no committed archive receipt`,
              );
            yield* cleanup();
            return undefined;
          }
          const inspected = yield* Effect.exit(inspectArchive(operation.outputPath));
          if (Exit.isFailure(inspected)) {
            if (operation.phase === "complete")
              return yield* recoveryFence(
                `Snapshot operation ${operation.id} has an unreadable committed archive`,
              );
            // Publication uses an atomic link, so an unreadable or malformed destination was
            // already present when this operation tried to publish. Preserve it and settle only
            // the operation-owned staging paths.
            yield* cleanup();
            return undefined;
          }
          const entries = inspected.value;
          if (
            !entries.includes(MANIFEST_NAME) ||
            (!entries.includes("postgres") && !entries.includes("postgres/"))
          ) {
            if (operation.phase === "complete")
              return yield* recoveryFence(
                `Snapshot operation ${operation.id} has an invalid committed archive`,
              );
            // A destination may have been created by another actor after this operation was
            // admitted. Preserve it and remove only this operation's private staging paths.
            yield* cleanup();
            return undefined;
          }
          yield* fs.makeDirectory(expectedStaging, { recursive: true, mode: 0o700 });
          yield* runTar(["-xf", operation.outputPath, "-C", expectedStaging, "--no-same-owner"]);
          const manifest = yield* readManifest(fs, path, expectedStaging).pipe(
            Effect.mapError(stackError),
          );
          if (
            manifest.sourceInstanceId !== input.instance.id ||
            manifest.exportOperationId !== operation.id
          ) {
            if (operation.phase === "complete")
              return yield* recoveryFence(
                `Snapshot operation ${operation.id} has an unrelated committed archive`,
              );
            // The atomic link cannot have replaced a preexisting destination. Keep that archive
            // intact while settling the abandoned operation's own stage and claim.
            yield* cleanup();
            return undefined;
          }
          yield* cleanup();
          return undefined;
        }

        // The manifest is persisted by the stack, while the database data store belongs to the
        // selected runtime. Container data lives in a volume and is intentionally invisible to
        // the host filesystem.
        const dataExists = yield* options.snapshotData.exists(input);
        const manifestExists = yield* fs.exists(instancePaths.manifest);
        if (!dataExists && !manifestExists) {
          yield* cleanup();
          return undefined;
        }
        if (!dataExists || !manifestExists) {
          if (dataExists && !manifestExists && operation.phase === "settling") {
            yield* options.snapshotData.rollbackRestore(input);
            yield* cleanup();
            return undefined;
          }
          return yield* recoveryFence(
            `Restore operation ${operation.id} has incomplete committed data; refusing cleanup`,
          );
        }
        const contents = yield* fs
          .readFileString(instancePaths.manifest)
          .pipe(Effect.mapError((cause) => archiveError("Snapshot manifest is missing", cause)));
        const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(InstanceManifestSchema))(
          contents,
        ).pipe(Effect.mapError(() => archiveError("Snapshot manifest is invalid")));
        const workload = yield* workloadFor(input);
        const metadata = yield* options.snapshotMetadata(input, workload);
        const pgVersion = yield* options.snapshotData.readVersion(input);
        const expectedProfile = input.instance.initializationInputs?.profileId ?? null;
        if (manifest.profileId !== expectedProfile)
          return yield* recoveryFence(
            `Restore operation ${operation.id} has a mismatched initialization profile`,
          );
        if (
          manifest.dataFormat.provider !== "postgres" ||
          manifest.majorVersion !== ARCHIVE_MAJOR ||
          manifest.dataFormat.format !== "pgdata" ||
          manifest.dataFormat.majorVersion !== metadata.majorVersion ||
          manifest.artifactIdentity !== metadata.artifactIdentity ||
          manifest.runtimeIdentity !== metadata.runtimeIdentity ||
          pgVersion !== metadata.majorVersion
        )
          return yield* recoveryFence(
            `Restore operation ${operation.id} has unverified committed snapshot data`,
          );
        yield* cleanup();
        return descriptorFor(manifest);
      }).pipe(Effect.mapError(stackError)),
    );

  return { start, stop, destroy, exportSnapshot, restoreSnapshot, recoverSnapshot };
};

const resolvePaths = (stack: StackPaths, instanceId: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const instanceRoot = path.join(stack.runtime, "instances", instanceId);
    const data = path.join(stack.data, "instances", instanceId);
    return {
      instanceRoot,
      data,
      postgresData: path.join(data, "postgres"),
      manifest: path.join(data, MANIFEST_NAME),
      snapshotStaging: path.join(instanceRoot, "snapshots"),
    };
  });

const cleanupStaging = (
  options: PostgresInstanceRuntimeOptions,
  input: InstanceRuntimeInput,
  operation: "export" | "restore",
  stagedArchive?: string,
  stageClaim?: string,
) =>
  Effect.gen(function* () {
    const paths = yield* resolvePaths(options.paths, input.instance.id);
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    yield* removeIfPresent(
      fs,
      path.join(paths.snapshotStaging, `${operation}-${input.operation.id}`),
      true,
    );
    if (stagedArchive !== undefined) yield* removeIfPresent(fs, stagedArchive);
    if (stageClaim !== undefined) yield* removeIfPresent(fs, stageClaim);
  }).pipe(Effect.mapError(cleanupError));

const withCleanup =
  <E>(
    cleanup: () => Effect.Effect<
      void,
      StackCleanupError,
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >,
  ) =>
  <A>(
    operation: Effect.Effect<
      A,
      E,
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >,
  ): Effect.Effect<
    A,
    E | StackCleanupError,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  > =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const result = yield* Effect.exit(restore(operation));
        const cleanupResult = yield* Effect.exit(cleanup());
        if (Exit.isFailure(result) && Exit.isFailure(cleanupResult))
          return yield* cleanupError({ operation: result.cause, cleanup: cleanupResult.cause });
        if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
        if (Exit.isFailure(cleanupResult)) return yield* Effect.failCause(cleanupResult.cause);
        return result.value;
      }),
    );

const removeIfPresent = (
  fs: FileSystem.FileSystem,
  target: string,
  recursive = false,
): Effect.Effect<void, PlatformError.PlatformError> =>
  fs
    .remove(target, { recursive })
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        Predicate.isTagged(error.reason, "NotFound") ? Effect.void : Effect.fail(error),
      ),
    );

const journal = (
  options: PostgresInstanceRuntimeOptions,
  input: InstanceRuntimeInput,
  phase: "admitted" | "running" | "settling" | "cleanup" | "complete",
  patch?: Readonly<{
    readonly stagingPath?: string;
    readonly outputPath?: string;
    readonly helperId?: string;
  }>,
): Effect.Effect<void, StackError> => options.journal(input, phase, patch);

const manifestFor = (
  input: InstanceRuntimeInput,
  profileId: string | undefined,
  metadata: PostgresSnapshotMetadata,
): Effect.Effect<InstanceManifest, UnsupportedSnapshotError> => {
  if (!Number.isInteger(metadata.majorVersion) || metadata.majorVersion <= 0)
    return Effect.fail(
      new UnsupportedSnapshotError({
        message: "PostgreSQL workload has no resolvable major version",
        instanceId: input.instance.id,
      }),
    );
  const lineage =
    input.instance.data.origin === "fresh"
      ? input.instance.data.lineageId
      : input.instance.data.origin === "restored"
        ? input.instance.data.snapshot.lineageId
        : undefined;
  if (lineage === undefined)
    return Effect.fail(
      new UnsupportedSnapshotError({
        message: "PostgreSQL instance has no published data lineage",
        instanceId: input.instance.id,
      }),
    );
  return Effect.succeed({
    format: ARCHIVE_FORMAT,
    majorVersion: ARCHIVE_MAJOR,
    sourceInstanceId: input.instance.id,
    exportOperationId: input.operation.id,
    lineageId: lineage,
    profileId:
      profileId ??
      input.instance.initializationInputs?.profileId ??
      (input.instance.data.origin === "restored"
        ? input.instance.data.snapshot.initializationProfileId
        : null),
    artifactIdentity: metadata.artifactIdentity,
    runtimeIdentity: metadata.runtimeIdentity,
    recipes: input.instance.initialization?.recipes ?? [],
    dataFormat: { provider: "postgres", format: "pgdata", majorVersion: metadata.majorVersion },
  });
};

const descriptorFor = (manifest: InstanceManifest): SnapshotDescriptor => ({
  lineageId: manifest.lineageId,
  initializationProfileId: manifest.profileId,
  artifactIdentity: manifest.artifactIdentity,
  runtimeIdentity: manifest.runtimeIdentity,
  dataFormat: manifest.dataFormat,
  provenance: {
    sourceInstanceId: manifest.sourceInstanceId,
    exportOperationId: manifest.exportOperationId,
  },
});

const encodeManifest = (manifest: InstanceManifest): Effect.Effect<string, StackPreparationError> =>
  Schema.encodeEffect(Schema.fromJsonString(InstanceManifestSchema))(manifest).pipe(
    Effect.mapError(() => archiveError("Unable to encode snapshot manifest")),
  );
