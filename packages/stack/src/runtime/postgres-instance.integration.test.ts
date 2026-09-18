import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  Cause,
  Context,
  Crypto,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Ref,
  Redacted,
  Schema,
} from "effect";
import { compileServiceInstance, createExecutionPlan } from "../model/Compiler.ts";
import type { ExecutionPlan, PlannedWorkload } from "../model/ExecutionPlan.ts";
import {
  type PersistedPendingOperation,
  type PersistedServiceInstance,
} from "../model/ServiceRegistry.ts";
import { StackIdSchema } from "../public/StackId.ts";
import { ServiceInstanceIdSchema, type ServiceInstanceId } from "../public/ServiceInstanceId.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import type { StackPaths } from "../state/Paths.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import { StackCleanupError, StackPreparationError, StackRuntimeError } from "../public/Errors.ts";
import type { RuntimeArtifactPreparer } from "../preparation/RuntimeArtifacts.ts";
import {
  RuntimeDriverError,
  type ObservedWorkload,
  type RuntimeDriver,
  type RuntimeWorkloadKey,
} from "./RuntimeDriver.ts";
import { makePostgresInstanceRuntime } from "./PostgresInstanceRuntime.ts";
import { makeProductionRuntime } from "./ProductionRuntime.ts";
import type { StackStateStore } from "../state/StackStateStore.ts";
import { AUTH_JWT_SECRET_SLOT, resolveSecrets } from "../state/SecretStore.ts";

const runtime = { kind: "native" } as const satisfies StackRuntime;
const stackId = StackIdSchema.make("a".repeat(64));

const paths: StackPaths = {
  stackRoot: "/tmp/postgres-instance",
  stateDocument: "/tmp/postgres-instance/state.json",
  data: "/tmp/postgres-instance/data",
  logs: "/tmp/postgres-instance/logs",
  runtime: "/tmp/postgres-instance/runtime",
  controlMetadata: "/tmp/postgres-instance/control.json",
};

const makeInput = (
  state: PersistedStackState,
  instance: PersistedServiceInstance,
  plan: ExecutionPlan,
  operationId: string,
) => ({
  stackId,
  state,
  instance,
  plan,
  operation: { id: operationId, generation: 1 },
});

const makeDriver = (
  started: Array<{ readonly instanceId: ServiceInstanceId; readonly workloadId: string }>,
  remove?: () => Effect.Effect<void, RuntimeDriverError>,
  onStart?: (key: RuntimeWorkloadKey) => Effect.Effect<void>,
) =>
  ({
    observe: () => Effect.succeed([]),
    start: (key: RuntimeWorkloadKey, _workload: PlannedWorkload) =>
      Effect.gen(function* () {
        if (onStart !== undefined) yield* onStart(key);
        started.push({ instanceId: key.instanceId, workloadId: key.workloadId });
        return { ...key, state: "ready" as const } satisfies ObservedWorkload;
      }),
    stop: () => Effect.void,
    remove: remove ?? (() => Effect.void),
    cleanup: () => Effect.void,
    wipePersistentData: () => Effect.void,
  }) satisfies RuntimeDriver;

const makeState = (
  instances: ReadonlyArray<PersistedServiceInstance>,
  privatePorts: PersistedStackState["privatePorts"],
  selectedRuntime: StackRuntime = runtime,
): PersistedStackState => ({
  format: "supabase-stack-state-v2",
  identity: {
    projectRoot: "/tmp/postgres-instance",
    branchContext: "test",
    stackName: "postgres-instance",
  },
  runtime: selectedRuntime,
  preparation: "on-demand",
  security: {
    jwt: {
      issuer: null,
      expirySeconds: 3600,
      signing: { kind: "symmetric", secret: { slot: AUTH_JWT_SECRET_SLOT } },
    },
  },
  listeners: {},
  registry: { initialized: true, instances, defaultInstanceIds: {} },
  ports: [],
  privatePorts: privatePorts,
  secrets: {},
});

const EventsSchema = Schema.Array(
  Schema.Struct({
    url: Schema.String,
    password: Schema.String,
    site: Schema.String,
  }),
);

describe("postgres instance runtime", () => {
  it.live("reconciles requested catalog recipes on the exact instance and skips its receipt", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const context = Context.empty().pipe(
        Context.add(FileSystem.FileSystem, fileSystem),
        Context.add(Path.Path, path),
        Context.add(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      );
      const first = yield* compileServiceInstance(
        {
          service: "database",
          config: { password: Redacted.make("first-password"), settings: {} },
          initialization: { catalog: { auth: { settings: {} } } },
        },
        { projectRoot: paths.stackRoot, path, runtime },
      );
      const second = yield* compileServiceInstance(
        {
          service: "database",
          config: { password: Redacted.make("second-password"), settings: {} },
          initialization: { catalog: { auth: { settings: {} } } },
        },
        { projectRoot: paths.stackRoot, path, runtime },
      );
      const instances = [first.instance, second.instance];
      const privatePorts = instances.map((instance, index) => ({
        instanceId: instance.id,
        workloadId: `${instance.id}:database`,
        binding: "sql:internal",
        port: 55432 + index,
      }));
      const initial = makeState(instances, privatePorts);
      const plan = yield* createExecutionPlan(runtime, initial.registry);
      const current = yield* Ref.make(initial);
      const started: Array<{
        readonly instanceId: ServiceInstanceId;
        readonly workloadId: string;
      }> = [];
      const recipes: Array<{ readonly instanceId: string; readonly recipeId: string }> = [];
      const originsAtDriverStart: string[] = [];
      let failCatalog = false;
      let failRemove = false;
      const driver = makeDriver(
        started,
        () =>
          failRemove
            ? Effect.fail(
                new RuntimeDriverError({
                  message: "injected remove failure",
                  stackId,
                }),
              )
            : Effect.void,
        (key) =>
          Ref.get(current).pipe(
            Effect.tap((state) =>
              Effect.sync(() => {
                const instance = state.registry.instances.find(
                  (entry) => entry.id === key.instanceId,
                );
                if (instance !== undefined) originsAtDriverStart.push(instance.data.origin);
              }),
            ),
            Effect.asVoid,
          ),
      );
      const artifactPreparer: RuntimeArtifactPreparer = {
        prepare: (_runtime, workload) =>
          Effect.succeed({
            workloadId: workload.id,
            capability: workload.capability,
            version: "v2.196.0",
            outcome: "cached" as const,
            artifactRoot: "/tmp/postgres-instance/auth",
          }),
      };
      const provider = makePostgresInstanceRuntime({
        runtime,
        paths,
        driver,
        artifactPreparer,
        context,
        snapshotData: {
          exists: () => Effect.succeed(false),
          readVersion: () => Effect.succeed(17),
          restoreTargetEmpty: () => Effect.succeed(true),
          export: () => Effect.void,
          restore: () => Effect.void,
          rollbackRestore: () => Effect.void,
        },
        snapshotMetadata: () =>
          Effect.succeed({
            artifactIdentity: "postgres@17",
            runtimeIdentity: "native",
            majorVersion: 17,
          }),
        reconcileManaged: () => Effect.void,
        reconcileCatalogRecipe: (input, recipe) =>
          failCatalog
            ? Effect.fail(new StackRuntimeError({ message: "injected catalog failure", stackId }))
            : Effect.sync(() => {
                recipes.push({ instanceId: input.instance.id, recipeId: recipe.recipeId });
                return { artifactIdentity: `${recipe.service}@${recipe.version}` };
              }),
        publishInitialization: (input, evidence) =>
          Ref.modify(current, (state) => [
            undefined,
            {
              ...state,
              registry: {
                ...state.registry,
                instances: state.registry.instances.map((instance) =>
                  instance.id === input.instance.id
                    ? { ...instance, initialization: evidence }
                    : instance,
                ),
              },
            },
          ]),
        publishFreshData: (input, lineageId) =>
          Ref.update(current, (state) => ({
            ...state,
            registry: {
              ...state.registry,
              instances: state.registry.instances.map((instance) =>
                instance.id === input.instance.id
                  ? { ...instance, data: { origin: "fresh" as const, lineageId } }
                  : instance,
              ),
            },
          })),
        publishIncompleteData: (input) =>
          Ref.update(current, (state) => ({
            ...state,
            registry: {
              ...state.registry,
              instances: state.registry.instances.map((instance) =>
                instance.id === input.instance.id
                  ? {
                      ...instance,
                      data: { origin: "incomplete" as const, operationId: input.operation.id },
                    }
                  : instance,
              ),
            },
          })),
        publishAbsentData: (input) =>
          Ref.update(current, (state) => ({
            ...state,
            registry: {
              ...state.registry,
              instances: state.registry.instances.map((instance) =>
                instance.id === input.instance.id
                  ? { ...instance, data: { origin: "absent" as const } }
                  : instance,
              ),
            },
          })),
        journal: () => Effect.void,
      });

      for (const instance of instances) {
        const state = yield* Ref.get(current);
        const currentInstance = state.registry.instances.find(({ id }) => id === instance.id);
        if (currentInstance === undefined) throw new Error(`Missing ${instance.id}`);
        yield* provider.start(makeInput(state, currentInstance, plan, `start-${instance.id}`));
      }
      const firstState = yield* Ref.get(current);
      const firstCurrent = firstState.registry.instances.find(({ id }) => id === first.id);
      if (firstCurrent === undefined) throw new Error("Missing first database instance");
      yield* provider.start(makeInput(firstState, firstCurrent, plan, "restart-first"));

      expect(started.map(({ instanceId }) => instanceId)).toEqual([first.id, second.id, first.id]);
      expect(recipes).toEqual([
        { instanceId: first.id, recipeId: "auth:v2.196.0" },
        { instanceId: second.id, recipeId: "auth:v2.196.0" },
      ]);
      failCatalog = true;
      failRemove = true;
      const failed = yield* Effect.exit(
        provider.start(makeInput(initial, first.instance, plan, "cleanup-failure")),
      );
      expect(Exit.isFailure(failed)).toBe(true);
      if (Exit.isFailure(failed)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(failed.cause));
        expect(error).toBeInstanceOf(StackCleanupError);
      }
      expect(originsAtDriverStart.at(-1)).toBe("incomplete");
      const failedState = yield* Ref.get(current);
      const failedInstance = failedState.registry.instances.find(({ id }) => id === first.id);
      expect(failedInstance?.data).toEqual({
        origin: "incomplete",
        operationId: "cleanup-failure",
      });

      failCatalog = false;
      failRemove = false;
      if (failedInstance === undefined) throw new Error("Missing failed database instance");
      yield* provider.start(makeInput(failedState, failedInstance, plan, "retry-success"));
      const retriedState = yield* Ref.get(current);
      const retriedInstance = retriedState.registry.instances.find(({ id }) => id === first.id);
      expect(retriedInstance?.data).toEqual({ origin: "fresh", lineageId: "retry-success" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("round trips a native instance archive with source provenance", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const context = Context.empty().pipe(
        Context.add(FileSystem.FileSystem, fileSystem),
        Context.add(Path.Path, path),
        Context.add(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      );
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "postgres-snapshot-" });
      const snapshotPaths: StackPaths = {
        stackRoot: root,
        stateDocument: path.join(root, "state.json"),
        data: path.join(root, "data"),
        logs: path.join(root, "logs"),
        runtime: path.join(root, "runtime"),
        controlMetadata: path.join(root, "control.json"),
      };
      const compiled = yield* compileServiceInstance(
        {
          service: "database",
          config: { password: Redacted.make("snapshot-password"), settings: {} },
          initialization: { catalog: { auth: { settings: {} } } },
        },
        { projectRoot: root, path, runtime },
      );
      const source = {
        ...compiled.instance,
        data: { origin: "fresh" as const, lineageId: "lineage-source" },
      };
      const target = {
        ...compiled.instance,
        id: ServiceInstanceIdSchema.make("target-db"),
        data: { origin: "fresh" as const, lineageId: "lineage-target" },
      };
      const instances = [source, target];
      const privatePorts = instances.map((instance, index) => ({
        instanceId: instance.id,
        workloadId: `${instance.id}:database`,
        binding: "sql:internal",
        port: 55532 + index,
      }));
      const state = makeState(instances, privatePorts);
      const plan = yield* createExecutionPlan(runtime, state.registry);
      const workload = plan.workloads.find(({ instanceId }) => instanceId === source.id);
      if (workload === undefined) throw new Error("Missing source database workload");
      const sourceData = path.join(snapshotPaths.data, "instances", source.id, "postgres");
      yield* fileSystem.makeDirectory(sourceData, { recursive: true, mode: 0o700 });
      const sourceVersion = path.join(sourceData, "PG_VERSION");
      yield* fileSystem.writeFileString(sourceVersion, "17\n");
      yield* fileSystem.chmod(sourceVersion, 0o600);
      const driver = makeDriver([]);
      let failJournalComplete = false;
      let failRestoreBeforeCopy = false;
      let failRestoreEmptyProbe = false;
      let restoreFailureObserved = false;
      let failRestore = false;
      let failManifestWrite = false;
      let publishedData: PersistedServiceInstance["data"] = { origin: "absent" };
      let restoreEntryData: PersistedServiceInstance["data"] | undefined;
      const artifactPreparer: RuntimeArtifactPreparer = {
        prepare: () =>
          Effect.succeed({
            workloadId: workload.id,
            capability: "database" as const,
            version: "17.6.1.168",
            outcome: "cached" as const,
          }),
      };
      const provider = makePostgresInstanceRuntime({
        runtime,
        paths: snapshotPaths,
        driver,
        artifactPreparer,
        context,
        snapshotData: {
          exists: (input) =>
            fileSystem
              .exists(path.join(snapshotPaths.data, "instances", input.instance.id, "postgres"))
              .pipe(
                Effect.mapError((cause) => new StackPreparationError({ message: "exists", cause })),
              ),
          readVersion: (input) =>
            fileSystem
              .readFileString(
                path.join(
                  snapshotPaths.data,
                  "instances",
                  input.instance.id,
                  "postgres",
                  "PG_VERSION",
                ),
              )
              .pipe(
                Effect.map((contents) => Number(contents.trim())),
                Effect.mapError(
                  (cause) => new StackPreparationError({ message: "version", cause }),
                ),
              ),
          restoreTargetEmpty: (input) =>
            failRestoreEmptyProbe && restoreFailureObserved
              ? Effect.die("injected restore empty probe defect")
              : fileSystem
                  .exists(path.join(snapshotPaths.data, "instances", input.instance.id))
                  .pipe(
                    Effect.flatMap((exists) =>
                      exists
                        ? fileSystem
                            .readDirectory(
                              path.join(snapshotPaths.data, "instances", input.instance.id),
                            )
                            .pipe(Effect.map((entries) => entries.length === 0))
                        : Effect.succeed(true),
                    ),
                    Effect.mapError(
                      (cause) => new StackPreparationError({ message: "empty", cause }),
                    ),
                  ),
          export: (_input, destination) =>
            fileSystem
              .copy(sourceData, destination, { overwrite: false })
              .pipe(
                Effect.mapError((cause) => new StackPreparationError({ message: "export", cause })),
              ),
          restore: (_input, sourcePath, destination) =>
            Effect.gen(function* () {
              restoreEntryData = publishedData;
              restoreFailureObserved = true;
              if (failRestoreBeforeCopy)
                return yield* new StackPreparationError({
                  message: "injected empty restore failure",
                });
              yield* fileSystem
                .copy(sourcePath, destination, { overwrite: false })
                .pipe(
                  Effect.mapError(
                    (cause) => new StackPreparationError({ message: "restore", cause }),
                  ),
                );
              if (failManifestWrite)
                yield* fileSystem
                  .makeDirectory(path.join(path.dirname(destination), "manifest.json"))
                  .pipe(
                    Effect.mapError(
                      (cause) => new StackPreparationError({ message: "manifest", cause }),
                    ),
                  );
              if (failRestore)
                return yield* new StackPreparationError({ message: "injected restore failure" });
            }),
          rollbackRestore: (input) =>
            fileSystem
              .remove(path.join(snapshotPaths.data, "instances", input.instance.id, "postgres"), {
                recursive: true,
              })
              .pipe(
                Effect.mapError(
                  (cause) => new StackPreparationError({ message: "rollback", cause }),
                ),
              ),
        },
        snapshotMetadata: () =>
          Effect.succeed({
            artifactIdentity: "postgres@17.6.1.168",
            runtimeIdentity: "native",
            majorVersion: 17,
          }),
        reconcileManaged: () => Effect.void,
        reconcileCatalogRecipe: () =>
          Effect.fail(new StackRuntimeError({ message: "catalog is not used in snapshot test" })),
        publishInitialization: () => Effect.void,
        publishFreshData: () => Effect.void,
        publishIncompleteData: (input) =>
          Effect.sync(() => {
            publishedData = { origin: "incomplete", operationId: input.operation.id };
          }),
        publishAbsentData: () =>
          Effect.sync(() => {
            publishedData = { origin: "absent" };
          }),
        journal: (_input, phase) =>
          failJournalComplete && phase === "complete"
            ? Effect.fail(new StackRuntimeError({ message: "injected completion journal failure" }))
            : Effect.void,
      });
      const sourceInput = makeInput(state, source, plan, "export-operation");
      const archive = path.join(root, "source.snapshot.tar");
      const descriptor = yield* provider.exportSnapshot(sourceInput, { destination: archive });
      expect(descriptor.provenance).toEqual({
        sourceInstanceId: source.id,
        exportOperationId: "export-operation",
      });
      const targetInput = makeInput(state, target, plan, "restore-operation");
      const restored = yield* provider.restoreSnapshot(targetInput, { source: archive });
      expect(restored.provenance).toEqual(descriptor.provenance);
      expect(
        yield* fileSystem.readFileString(
          path.join(snapshotPaths.data, "instances", target.id, "postgres", "PG_VERSION"),
        ),
      ).toBe("17\n");
      const restoredVersion = yield* fileSystem.stat(
        path.join(snapshotPaths.data, "instances", target.id, "postgres", "PG_VERSION"),
      );
      expect(Number(restoredVersion.mode) & 0o777).toBe(0o600);
      const restoredData = yield* fileSystem.stat(
        path.join(snapshotPaths.data, "instances", target.id, "postgres"),
      );
      expect(Number(restoredData.mode) & 0o777).toBe(0o700);
      expect(
        yield* fileSystem.exists(
          path.join(
            snapshotPaths.runtime,
            "instances",
            source.id,
            "snapshots",
            "export-export-operation",
          ),
        ),
      ).toBe(false);
      yield* fileSystem.remove(path.join(snapshotPaths.data, "instances", target.id), {
        recursive: true,
      });
      failRestoreBeforeCopy = true;
      failRestoreEmptyProbe = true;
      restoreFailureObserved = false;
      const uncertainFailure = yield* Effect.exit(
        provider.restoreSnapshot(targetInput, { source: archive }),
      );
      expect(Exit.isFailure(uncertainFailure)).toBe(true);
      if (Exit.isFailure(uncertainFailure)) {
        expect(Cause.hasDies(uncertainFailure.cause)).toBe(true);
        expect(
          uncertainFailure.cause.reasons.some(
            (reason) => Cause.isFailReason(reason) && reason.error instanceof StackCleanupError,
          ),
        ).toBe(true);
      }
      yield* fileSystem.remove(path.join(snapshotPaths.data, "instances", target.id), {
        recursive: true,
      });
      failRestoreEmptyProbe = false;
      const cleanFailure = yield* Effect.exit(
        provider.restoreSnapshot(targetInput, { source: archive }),
      );
      expect(Exit.isFailure(cleanFailure)).toBe(true);
      expect(publishedData).toEqual({ origin: "absent" });
      expect(
        yield* fileSystem.exists(path.join(snapshotPaths.data, "instances", target.id, "postgres")),
      ).toBe(false);
      failRestoreBeforeCopy = false;
      failRestore = true;
      const failedMutation = yield* Effect.exit(
        provider.restoreSnapshot(targetInput, { source: archive }),
      );
      expect(Exit.isFailure(failedMutation)).toBe(true);
      if (Exit.isFailure(failedMutation)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(failedMutation.cause));
        expect(error).toBeInstanceOf(StackCleanupError);
      }
      expect(restoreEntryData).toEqual({
        origin: "incomplete",
        operationId: "restore-operation",
      });
      expect(publishedData).toEqual({
        origin: "incomplete",
        operationId: "restore-operation",
      });
      yield* fileSystem.remove(path.join(snapshotPaths.data, "instances", target.id), {
        recursive: true,
      });
      failRestore = false;
      failManifestWrite = true;
      const failedManifest = yield* Effect.exit(
        provider.restoreSnapshot(targetInput, { source: archive }),
      );
      expect(Exit.isFailure(failedManifest)).toBe(true);
      if (Exit.isFailure(failedManifest)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(failedManifest.cause));
        expect(error).toBeInstanceOf(StackCleanupError);
      }
      expect(publishedData).toEqual({
        origin: "incomplete",
        operationId: "restore-operation",
      });
      expect(
        yield* fileSystem.exists(
          path.join(snapshotPaths.data, "instances", target.id, "manifest.json"),
        ),
      ).toBe(true);
      expect(
        yield* fileSystem.exists(path.join(snapshotPaths.data, "instances", target.id, "postgres")),
      ).toBe(false);
      yield* fileSystem.remove(path.join(snapshotPaths.data, "instances", target.id), {
        recursive: true,
      });
      failManifestWrite = false;
      failJournalComplete = true;
      const failedRestore = yield* Effect.exit(
        provider.restoreSnapshot(targetInput, { source: archive }),
      );
      expect(Exit.isFailure(failedRestore)).toBe(true);
      if (Exit.isFailure(failedRestore)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(failedRestore.cause));
        expect(error).toBeInstanceOf(StackCleanupError);
      }
      expect(publishedData).toEqual({
        origin: "incomplete",
        operationId: "restore-operation",
      });
      expect(
        yield* fileSystem.exists(path.join(snapshotPaths.data, "instances", target.id, "postgres")),
      ).toBe(true);
      const recoveryOperation: PersistedPendingOperation = {
        id: "restore-operation",
        kind: "restoreSnapshot",
        generation: 1,
        ownerSessionId: "snapshot-test",
        phase: "complete",
      };
      const recovered = yield* provider.recoverSnapshot(targetInput, recoveryOperation);
      expect(recovered).toEqual(restored);

      yield* fileSystem.remove(
        path.join(snapshotPaths.data, "instances", target.id, "manifest.json"),
      );
      const rolledBack = yield* provider.recoverSnapshot(targetInput, {
        ...recoveryOperation,
        phase: "settling",
      });
      expect(rolledBack).toBeUndefined();
      expect(
        yield* fileSystem.exists(path.join(snapshotPaths.data, "instances", target.id, "postgres")),
      ).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("recovers a container volume without reading host PGDATA", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const context = Context.empty().pipe(
        Context.add(FileSystem.FileSystem, fileSystem),
        Context.add(Path.Path, path),
        Context.add(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      );
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "postgres-volume-snapshot-",
      });
      const containerRuntime = {
        kind: "container",
        engine: "docker",
      } as const satisfies StackRuntime;
      const snapshotPaths: StackPaths = {
        stackRoot: root,
        stateDocument: path.join(root, "state.json"),
        data: path.join(root, "data"),
        logs: path.join(root, "logs"),
        runtime: path.join(root, "runtime"),
        controlMetadata: path.join(root, "control.json"),
      };
      const compiled = yield* compileServiceInstance(
        { service: "database", config: { password: Redacted.make("volume-password") } },
        { projectRoot: root, path, runtime: containerRuntime },
      );
      const source = {
        ...compiled.instance,
        id: ServiceInstanceIdSchema.make("volume-source"),
        data: { origin: "fresh" as const, lineageId: "volume-lineage" },
      };
      const target = {
        ...compiled.instance,
        id: ServiceInstanceIdSchema.make("volume-target"),
        data: { origin: "fresh" as const, lineageId: "target-lineage" },
      };
      const instances = [source, target];
      const privatePorts = instances.map((instance, index) => ({
        instanceId: instance.id,
        workloadId: `${instance.id}:database`,
        binding: "sql:internal",
        port: 56532 + index,
      }));
      const state = makeState(instances, privatePorts, containerRuntime);
      const plan = yield* createExecutionPlan(containerRuntime, state.registry);
      const sourceWorkload = plan.workloads.find(({ instanceId }) => instanceId === source.id);
      if (sourceWorkload === undefined) throw new Error("Missing source database workload");
      const volumes = new Map<ServiceInstanceId, number>([[source.id, 17]]);
      const targetHostData = path.join(snapshotPaths.data, "instances", target.id);
      yield* fileSystem.makeDirectory(targetHostData, { recursive: true, mode: 0o700 });
      const provider = makePostgresInstanceRuntime({
        runtime: containerRuntime,
        paths: snapshotPaths,
        driver: makeDriver([]),
        artifactPreparer: {
          prepare: () =>
            Effect.succeed({
              workloadId: sourceWorkload.id,
              capability: "database" as const,
              version: "17.6.1.168",
              outcome: "cached" as const,
            }),
        },
        context,
        snapshotData: {
          exists: (input) => Effect.succeed(volumes.has(input.instance.id)),
          readVersion: (input) => {
            const version = volumes.get(input.instance.id);
            return version === undefined
              ? Effect.fail(
                  new StackRuntimeError({
                    message: "Container volume is absent",
                    stackId,
                    workloadId: input.instance.id,
                  }),
                )
              : Effect.succeed(version);
          },
          restoreTargetEmpty: (input) => Effect.succeed(!volumes.has(input.instance.id)),
          export: (_input, destination) =>
            fileSystem.makeDirectory(destination, { recursive: true, mode: 0o700 }).pipe(
              Effect.andThen(
                fileSystem.writeFileString(path.join(destination, "PG_VERSION"), "17\n"),
              ),
              Effect.mapError((cause) => new StackPreparationError({ message: "export", cause })),
            ),
          restore: (input) => Effect.sync(() => volumes.set(input.instance.id, 17)),
          rollbackRestore: (input) => Effect.sync(() => volumes.delete(input.instance.id)),
        },
        snapshotMetadata: () =>
          Effect.succeed({
            artifactIdentity: "postgres@17.6.1.168",
            runtimeIdentity: "container:docker",
            majorVersion: 17,
          }),
        reconcileManaged: () => Effect.void,
        reconcileCatalogRecipe: () =>
          Effect.fail(new StackRuntimeError({ message: "catalog is not used in volume test" })),
        publishInitialization: () => Effect.void,
        publishFreshData: () => Effect.void,
        publishIncompleteData: () => Effect.void,
        publishAbsentData: () => Effect.void,
        journal: () => Effect.void,
      });
      const sourceInput = makeInput(state, source, plan, "volume-export-operation");
      const archive = path.join(root, "volume.snapshot.tar");
      const descriptor = yield* provider.exportSnapshot(sourceInput, { destination: archive });
      const targetInput = makeInput(state, target, plan, "volume-restore-operation");
      const restored = yield* provider.restoreSnapshot(targetInput, { source: archive });
      expect(restored.provenance).toEqual(descriptor.provenance);
      expect(yield* fileSystem.exists(path.join(targetHostData, "postgres"))).toBe(false);
      const recovered = yield* provider.recoverSnapshot(targetInput, {
        id: "volume-restore-operation",
        kind: "restoreSnapshot",
        generation: 1,
        ownerSessionId: "snapshot-test",
        phase: "complete",
      });
      expect(recovered).toEqual(restored);

      yield* fileSystem.remove(path.join(targetHostData, "manifest.json"));
      const rolledBack = yield* provider.recoverSnapshot(targetInput, {
        id: "volume-restore-operation",
        kind: "restoreSnapshot",
        generation: 1,
        ownerSessionId: "snapshot-test",
        phase: "settling",
      });
      expect(rolledBack).toBeUndefined();
      expect(volumes.has(target.id)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "runs the default catalog adapter for a disabled live service on the requested database",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const crypto = yield* Crypto.Crypto;
          const root = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "postgres-production-",
          });
          const db = yield* compileServiceInstance(
            {
              service: "database",
              config: {
                password: Redacted.make("database-password"),
                settings: { health_timeout: "2m" },
              },
              initialization: {
                catalog: {
                  auth: { settings: { site_url: "https://recipe.example" } },
                  storage: { settings: {} },
                  realtime: { settings: {} },
                },
              },
            },
            {
              projectRoot: root,
              path,
              runtime,
              instanceId: ServiceInstanceIdSchema.make("db-one"),
            },
          );
          const authVersion = db.instance.initializationInputs?.catalog.auth?.version;
          if (authVersion === undefined) throw new Error("Missing compiled auth catalog version");
          const catalogRecipeIds = Object.entries(
            db.instance.initializationInputs?.catalog ?? {},
          ).map(([service, recipe]) => `${service}:${recipe.version}`);
          const second = yield* compileServiceInstance(
            {
              service: "database",
              config: {
                password: Redacted.make("second-database-password"),
                settings: { health_timeout: "2m" },
              },
              initialization: {
                catalog: {
                  auth: { settings: { site_url: "https://recipe.example" } },
                  storage: { settings: {} },
                  realtime: { settings: {} },
                },
              },
            },
            {
              projectRoot: root,
              path,
              runtime,
              instanceId: ServiceInstanceIdSchema.make("db-two"),
            },
          );
          const instances = [db.instance, second.instance];
          const privatePorts = instances.map((instance, index) => ({
            instanceId: instance.id,
            workloadId: `${instance.id}:database`,
            binding: "sql:internal" as const,
            port: 55632 + index,
          }));
          const baseState = makeState(instances, privatePorts);
          const firstSecrets = yield* resolveSecrets(
            { declarations: db.secretSlots },
            undefined,
            "unconfigured",
          );
          const secondSecrets = yield* resolveSecrets(
            { declarations: second.secretSlots },
            undefined,
            "unconfigured",
          );
          const state: PersistedStackState = {
            ...baseState,
            identity: { projectRoot: root, branchContext: "test", stackName: "production" },
            security: {
              jwt: {
                issuer: null,
                expirySeconds: 3600,
                signing: { kind: "symmetric", secret: { slot: AUTH_JWT_SECRET_SLOT } },
              },
            },
            secrets: {
              ...firstSecrets.persisted,
              ...secondSecrets.persisted,
              [AUTH_JWT_SECRET_SLOT]: { policy: "managed", value: "jwt-secret" },
              [`secret:${db.id}.settings.db_enc_key`]: {
                policy: "managed",
                value: "realtime-db-key",
              },
              [`secret:${db.id}.settings.secret_key_base`]: {
                policy: "managed",
                value: "realtime-secret-key",
              },
              [`secret:${second.id}.settings.db_enc_key`]: {
                policy: "managed",
                value: "second-realtime-db-key",
              },
              [`secret:${second.id}.settings.secret_key_base`]: {
                policy: "managed",
                value: "second-realtime-secret-key",
              },
            },
            registry: {
              ...baseState.registry,
              defaultInstanceIds: { database: db.instance.id },
              instances: instances.map((instance) => ({
                ...instance,
                pendingOperation: {
                  id: `production-start-${instance.id}`,
                  kind: "start" as const,
                  generation: 1,
                  ownerSessionId: "production-test",
                  phase: "admitted" as const,
                },
              })),
            },
          };
          const plan = yield* createExecutionPlan(runtime, state.registry);
          const eventsPath = path.join(root, "catalog-env.json");
          const dbScript = path.join(root, "bin", "supabase-postgres-start");
          const authScript = path.join(root, "bin", "auth");
          const scriptEventsPath = eventsPath.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
          yield* fileSystem.makeDirectory(path.dirname(dbScript), { recursive: true });
          yield* fileSystem.writeFileString(
            dbScript,
            `#!/usr/bin/env node
const net = require("node:net");
const port = Number(process.argv[process.argv.indexOf("-p") + 1]);
const server = net.createServer((socket) => socket.end());
server.listen(port, "127.0.0.1");
const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
`,
          );
          yield* fileSystem.writeFileString(
            authScript,
            `#!/usr/bin/env node
const fs = require("node:fs");
const eventsPath = '${scriptEventsPath}';
// The fixture is a standalone Node script and has no Effect Schema runtime.
// oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- standalone Node fixture has no Effect services.
const events = fs.existsSync(eventsPath) ? JSON.parse(fs.readFileSync(eventsPath, "utf8")) : [];
events.push({ url: process.env.GOTRUE_DB_DATABASE_URL, password: process.env.GOTRUE_JWT_SECRET, site: process.env.GOTRUE_SITE_URL });
fs.writeFileSync(eventsPath, JSON.stringify(events));
`,
          );
          yield* fileSystem.writeFileString(
            path.join(root, "bin", "prepare"),
            "#!/usr/bin/env node\n",
          );
          yield* fileSystem.chmod(dbScript, 0o755);
          yield* fileSystem.chmod(authScript, 0o755);
          yield* fileSystem.chmod(path.join(root, "bin", "prepare"), 0o755);
          let current = state;
          const stateStore: StackStateStore = {
            read: (_id) => Effect.succeed(current),
            initialize: () => Effect.die("unused"),
            replace: (_id, next) => Effect.sync(() => void (current = next)),
            replaceUnlocked: (_id, next) => Effect.sync(() => void (current = next)),
            update: (_id, transform) =>
              Effect.gen(function* () {
                const next = yield* transform(current);
                current = next;
                return next;
              }),
            cleanup: () => Effect.die("unused"),
            recoverRuntimeRemnant: () => Effect.void,
          };
          const artifactPreparer: RuntimeArtifactPreparer = {
            prepare: (_runtime, workload) =>
              Effect.succeed({
                workloadId: workload.id,
                capability: workload.capability,
                version: workload.recipeId.startsWith("auth:") ? authVersion : "17.6.1.168",
                outcome: "cached" as const,
                artifactRoot: root,
              }),
          };
          let failBootstrap = true;
          const runtimeInstance = yield* makeProductionRuntime({
            stateRoot: root,
            stackId,
            ownerSessionId: "production-test",
            stateStore,
            context: Context.empty().pipe(
              Context.add(FileSystem.FileSystem, fileSystem),
              Context.add(Path.Path, path),
              Context.add(Crypto.Crypto, crypto),
            ),
            artifactPreparer,
            bootstrapDatabase: () =>
              failBootstrap
                ? Effect.fail(new StackPreparationError({ message: "injected bootstrap failure" }))
                : Effect.void,
          });
          const startedInputs = [];
          for (const instance of current.registry.instances) {
            const input = {
              stackId,
              state: current,
              instance,
              plan,
              operation: { id: `production-start-${instance.id}`, generation: 1 },
            };
            if (instance.id === db.id) {
              const failed = yield* Effect.exit(runtimeInstance.start(input));
              expect(Exit.isFailure(failed)).toBe(true);
              const failedState = yield* stateStore.read(stackId);
              if (failedState === undefined) throw new Error("Missing failed production state");
              const failedInstance = failedState.registry.instances.find(
                (entry) => entry.id === db.id,
              );
              expect(failedInstance?.data).toEqual({
                origin: "incomplete",
                operationId: input.operation.id,
              });
              if (failedInstance === undefined) throw new Error("Missing failed database instance");
              failBootstrap = false;
              const retryInput = { ...input, state: failedState, instance: failedInstance };
              yield* runtimeInstance.start(retryInput);
              startedInputs.push(retryInput);
            } else {
              yield* runtimeInstance.start(input);
              startedInputs.push(input);
            }
          }
          const firstInput = startedInputs.find((input) => input.instance.id === db.id);
          if (firstInput === undefined) throw new Error("Missing started database input");
          yield* runtimeInstance.stop(firstInput);
          const freshState = yield* stateStore.read(stackId);
          if (freshState === undefined) throw new Error("Missing fresh production state");
          const freshInstance = freshState.registry.instances.find(({ id }) => id === db.id);
          if (freshInstance === undefined) throw new Error("Missing fresh database instance");
          const restartOperationId = "production-restart-db-one";
          yield* stateStore.update(stackId, (current) =>
            Effect.succeed({
              ...current,
              registry: {
                ...current.registry,
                instances: current.registry.instances.map((entry) =>
                  entry.id === db.id
                    ? {
                        ...entry,
                        pendingOperation: {
                          id: restartOperationId,
                          kind: "start" as const,
                          generation: 1,
                          ownerSessionId: "production-test",
                          phase: "admitted" as const,
                        },
                      }
                    : entry,
                ),
              },
            }),
          );
          const restartState = yield* stateStore.read(stackId);
          if (restartState === undefined) throw new Error("Missing restart production state");
          const restartInstance = restartState.registry.instances.find(({ id }) => id === db.id);
          if (restartInstance === undefined) throw new Error("Missing restart database instance");
          const restartInput = {
            stackId,
            state: restartState,
            instance: restartInstance,
            plan,
            operation: { id: restartOperationId, generation: 1 },
          };
          yield* runtimeInstance.start(restartInput);
          startedInputs.splice(startedInputs.indexOf(firstInput), 1, restartInput);
          const preserved = yield* stateStore.read(stackId);
          if (preserved === undefined) throw new Error("Missing preserved production state");
          expect(preserved.registry.instances.find(({ id }) => id === db.id)?.data).toEqual({
            origin: "fresh",
            lineageId: firstInput.operation.id,
          });
          const events = yield* Schema.decodeEffect(Schema.fromJsonString(EventsSchema))(
            yield* fileSystem.readFileString(eventsPath),
          );
          expect(events).toHaveLength(2);
          expect(events.map((event) => event.url)).toEqual(
            expect.arrayContaining([
              "postgresql://supabase_auth_admin:database-password@127.0.0.1:55632/postgres",
              "postgresql://supabase_auth_admin:second-database-password@127.0.0.1:55633/postgres",
            ]),
          );
          expect(events.every((event) => event.password === "jwt-secret")).toBe(true);
          expect(events.every((event) => event.site === "https://recipe.example")).toBe(true);
          const updated = yield* stateStore.read(stackId);
          if (updated === undefined) throw new Error("Missing updated state");
          expect(updated.registry.instances.map((instance) => instance.data.origin)).toEqual([
            "fresh",
            "fresh",
          ]);
          expect(
            updated.registry.instances.map((instance) => instance.initialization?.recipes),
          ).toEqual(
            instances.map(() =>
              catalogRecipeIds.map((recipeId) =>
                expect.objectContaining({ recipeId, completed: true }),
              ),
            ),
          );
          for (const input of startedInputs) yield* runtimeInstance.stop(input);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );
});
