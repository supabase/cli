import {
  Cause,
  Config,
  Context,
  Crypto,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Path,
  Ref,
  Scope,
  Schedule,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import type { StackDefinition } from "../model/Compiler.ts";
import { bundleServeMainTemplate } from "../functions/serve-main-bundler.ts";
import {
  makeFunctionsBootstrapOwner,
  type FunctionsBootstrapOwner,
} from "../functions/FunctionsBootstrap.ts";
import { makePortRegistry } from "../state/PortRegistry.ts";
import type { StackStateStore } from "../state/StackStateStore.ts";
import { resolveStackPaths } from "../state/Paths.ts";
import { redactKnownSecrets } from "../state/SecretStore.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import type { PersistedSecretValues } from "../state/StackState.ts";
import type { StackId } from "../public/StackId.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import {
  GatewayActivationError,
  StackPreparationError,
  ArtifactIntegrityError,
  ContainerPullError,
  StackRuntimeMismatchError,
  StackStateInvalidError,
  type StackError,
} from "../public/Errors.ts";
import { makeSupervisorIngress, type SupervisorIngress } from "../supervisor/Ingress.ts";
import { makeLogStore, type LogStore, type LogRecord } from "../supervisor/LogStore.ts";
import type { LifecycleInput, LifecyclePrepared } from "../supervisor/Lifecycle.ts";
import type { SupervisorRuntime, SupervisorRuntimeFactory } from "../supervisor/Supervisor.ts";
import {
  makeProductionRuntimeArtifactPreparer,
  type PreparedWorkloadArtifact,
  type RuntimeArtifactPreparer,
} from "../preparation/RuntimeArtifacts.ts";
import { makeRuntimeEnvFileOwner, type RuntimeEnvFileOwner } from "./RuntimeEnvFile.ts";
import {
  makeRuntimeInputOwner,
  type RuntimeInputOwner,
  type RuntimeJsonFetcher,
} from "./RuntimeInputOwner.ts";
import type { NativeProcessSpec } from "./NativeProcess.ts";
import {
  FUNCTIONS_BOOTSTRAP_CONTAINER_PATH,
  resolveContainerResolutionFor,
  runtimeSpecFor,
  validatePrivateAssignments,
  validateWorkloadRuntimeInputs,
  type WorkloadRuntimeInputs,
} from "./WorkloadRuntimeSpec.ts";
import { makeNativeRuntime } from "./NativeRuntime.ts";
import { makeContainerRuntime, type ContainerWorkloadResolution } from "./ContainerRuntime.ts";
import { DEFAULT_READINESS_DEADLINE, probeReadiness } from "./ReadinessProbe.ts";
import { parseGoDuration } from "../model/capabilities/database.ts";
import type { ContainerEngine, ContainerHostRoute } from "./ContainerEngine.ts";
import { bootstrapDatabaseAt } from "./PostgresDatabaseSession.ts";
import { DatabaseBootstrapError } from "../model/DatabaseBootstrap.ts";
import {
  RuntimeDriverError,
  type RuntimeDriver,
  type RuntimeWorkloadKey,
} from "./RuntimeDriver.ts";

type RuntimeContext = FileSystem.FileSystem | Path.Path | Crypto.Crypto;

export interface ProductionRuntimeFactoryOptions {
  readonly stateRoot: string;
  readonly artifactCacheRoot?: string;
  readonly stackId: StackId;
  readonly ownerSessionId: string;
  readonly stateStore: StackStateStore;
  readonly context: Context.Context<RuntimeContext>;
  readonly artifactPreparer?: RuntimeArtifactPreparer;
  readonly containerEngine?: ContainerEngine;
  readonly ingress?: SupervisorIngress;
  readonly logStore?: LogStore;
  readonly envFileOwner?: RuntimeEnvFileOwner;
  readonly functionsBootstrapOwner?: FunctionsBootstrapOwner;
  readonly fetchJson?: RuntimeJsonFetcher;
  readonly bootstrapDatabase?: (
    state: PersistedStackState,
  ) => Effect.Effect<void, DatabaseBootstrapError | StackPreparationError>;
}

const preparationError = (message: string, cause?: unknown): StackPreparationError =>
  new StackPreparationError({ message, ...(cause === undefined ? {} : { cause }) });

const driverError = (
  key: Pick<RuntimeWorkloadKey, "stackId" | "workloadId">,
  message: string,
  cause?: unknown,
): RuntimeDriverError =>
  new RuntimeDriverError({
    message,
    stackId: key.stackId,
    workloadId: key.workloadId,
    ...(cause === undefined ? {} : { cause }),
  });

const stateSecrets = (state: PersistedStackState): ReadonlyArray<string> =>
  Object.values(state.secrets)
    .map((entry) => entry.value)
    .filter((value) => value.length > 0);

const currentStateReader = (options: ProductionRuntimeFactoryOptions) =>
  options.stateStore.read(options.stackId).pipe(
    Effect.provideContext(options.context),
    Effect.flatMap((state) =>
      state === undefined
        ? Effect.fail(
            new StackStateInvalidError({
              message: "Persisted stack state is missing",
              stackId: options.stackId,
            }),
          )
        : Effect.succeed(state),
    ),
  );

const artifactKey = (runtime: StackRuntime, workload: PlannedWorkload): string =>
  `${runtime.kind}:${runtime.kind === "container" ? runtime.engine : ""}:${workload.id}:${workload.specHash}:${workload.selected.kind === "native" ? workload.selected.release : workload.selected.image}`;

const runtimeMatches = (left: StackRuntime, right: StackRuntime): boolean => {
  if (left.kind !== right.kind) return false;
  if (left.kind === "native" || right.kind === "native") return true;
  return left.engine === right.engine;
};

const urlHost = (host: string): string => {
  const normalized = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return normalized.includes(":") && !normalized.startsWith("[") ? `[${normalized}]` : normalized;
};

const DATABASE_WORKLOAD_ID = "database:database";
/** Atomic lifecycle witness for a successfully migrated native cluster. */
export const NATIVE_DATABASE_MIGRATION_MARKER = ".supabase-stack-migration-complete";
const isDatabaseWorkload = (workload: PlannedWorkload): boolean =>
  workload.id === DATABASE_WORKLOAD_ID;
const configuredDatabaseReadinessDeadline = (
  definition: StackDefinition | undefined,
): Effect.Effect<Duration.Duration, StackPreparationError> => {
  if (definition === undefined)
    return Effect.fail(preparationError("Persisted database definition is missing"));
  const configured = definition.capabilities.database.settings.health_timeout;
  if (configured === undefined || configured === null)
    return Effect.fail(preparationError("Persisted database health_timeout is missing"));
  return Effect.try({
    try: () => parseGoDuration(configured),
    catch: (cause) => preparationError(`Invalid database health_timeout: ${configured}`, cause),
  }).pipe(
    Effect.flatMap((duration) =>
      Duration.isNegative(duration) || Duration.isZero(duration)
        ? Effect.fail(
            preparationError(
              `Invalid database health_timeout: ${configured}; duration must be positive`,
            ),
          )
        : Effect.succeed(duration),
    ),
  );
};

export const readinessDeadlineFor = (
  state: PersistedStackState,
  workload: PlannedWorkload,
): Effect.Effect<Duration.Duration, StackPreparationError> =>
  isDatabaseWorkload(workload)
    ? configuredDatabaseReadinessDeadline(state.definition)
    : Effect.succeed(DEFAULT_READINESS_DEADLINE);

const validateDatabaseReadinessBudget = (
  definition: StackDefinition,
  workloads: ReadonlyArray<PlannedWorkload>,
): Effect.Effect<void, StackPreparationError> =>
  workloads.some(isDatabaseWorkload)
    ? configuredDatabaseReadinessDeadline(definition).pipe(Effect.asVoid)
    : Effect.void;

const redactEntry = <A extends { readonly message: string }>(
  entry: A,
  secrets: ReadonlyArray<string>,
): A => {
  const message = redactKnownSecrets(entry.message, secrets);
  return message === entry.message ? entry : { ...entry, message };
};

/** Redacts against the monotonically growing set of secrets accepted by this owner. */
const dynamicLogStore = (base: LogStore, knownSecrets: Ref.Ref<ReadonlySet<string>>): LogStore => {
  const secrets = Ref.get(knownSecrets).pipe(Effect.map((values) => [...values]));
  return {
    path: base.path,
    append: (record: LogRecord) =>
      secrets.pipe(
        Effect.flatMap((known) =>
          base.append({ ...record, message: redactKnownSecrets(record.message, known) }),
        ),
      ),
    read: (options) =>
      secrets.pipe(
        Effect.flatMap((known) =>
          base
            .read(options)
            .pipe(Effect.map((entries) => entries.map((entry) => redactEntry(entry, known)))),
        ),
      ),
    stream: (options) =>
      Stream.unwrap(
        secrets.pipe(
          Effect.map((known) =>
            base.stream(options).pipe(Stream.map((entry) => redactEntry(entry, known))),
          ),
        ),
      ),
  };
};

const rememberSecrets = (
  knownSecrets: Ref.Ref<ReadonlySet<string>>,
  secrets: PersistedSecretValues,
): Effect.Effect<void> =>
  Ref.update(knownSecrets, (known) => {
    const next = new Set(known);
    for (const entry of Object.values(secrets)) {
      if (entry.value.length > 0) next.add(entry.value);
    }
    return next;
  });

const readinessFor = (
  state: PersistedStackState,
  workload: PlannedWorkload,
): Effect.Effect<void, StackPreparationError | RuntimeDriverError> => {
  const spec = runtimeSpecFor(workload);
  if (spec === undefined)
    return Effect.fail(preparationError(`Unknown runtime specification for ${workload.id}`));
  const endpoint = spec.privateEndpoint(state, spec.readiness.binding, "native");
  if (endpoint === undefined)
    return Effect.fail(preparationError(`Missing private readiness assignment for ${workload.id}`));
  return readinessDeadlineFor(state, workload).pipe(
    Effect.flatMap((deadline) =>
      probeReadiness(
        {
          mode: spec.readiness.protocol,
          host: "127.0.0.1",
          port: endpoint.port,
          ...(spec.readiness.path === undefined ? {} : { path: spec.readiness.path }),
          ...(spec.readiness.headers === undefined ? {} : { headers: spec.readiness.headers }),
        },
        { deadline },
      ),
    ),
  );
};

interface NativeDatabaseMigrationOptions {
  readonly key: Pick<RuntimeWorkloadKey, "stackId" | "workloadId">;
  readonly dataPath: string;
  readonly artifactRoot: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly endpointPort: number;
  readonly timeout: Duration.Duration;
  readonly fileSystem: FileSystem.FileSystem;
  readonly pathService: Path.Path;
}

/** Builds the one-shot native PostgreSQL migration process for an unmarked data directory. */
const prepareNativeDatabaseMigration = (
  options: NativeDatabaseMigrationOptions,
): Effect.Effect<NativeProcessSpec | undefined, RuntimeDriverError> =>
  Effect.gen(function* () {
    const {
      key,
      dataPath,
      artifactRoot,
      environment,
      endpointPort,
      timeout,
      fileSystem,
      pathService,
    } = options;
    const markerPath = pathService.join(dataPath, NATIVE_DATABASE_MIGRATION_MARKER);
    const migrated = yield* fileSystem
      .exists(markerPath)
      .pipe(
        Effect.mapError((error) =>
          driverError(key, `Unable to inspect native database data path: ${error.message}`, error),
        ),
      );
    if (migrated) return undefined;
    const pgVersionPath = pathService.join(dataPath, "PG_VERSION");
    const initialized = yield* fileSystem
      .exists(pgVersionPath)
      .pipe(
        Effect.mapError((error) =>
          driverError(key, `Unable to inspect native database data path: ${error.message}`, error),
        ),
      );
    if (initialized)
      yield* fileSystem
        .remove(dataPath, { recursive: true, force: true })
        .pipe(
          Effect.mapError((error) =>
            driverError(
              key,
              `Unable to remove incomplete native database data path: ${error.message}`,
              error,
            ),
          ),
        );
    const migrationsPath = pathService.join(artifactRoot, "share/supabase-cli/migrations");
    const artifactBin = pathService.join(artifactRoot, "bin");
    const hostPath = yield* Config.string("PATH").pipe(
      Config.withDefault(""),
      Effect.mapError((error) => driverError(key, "Unable to read host PATH", error)),
    );
    return {
      executable: pathService.join(migrationsPath, "migrate.sh"),
      cwd: migrationsPath,
      timeout,
      successMarker: markerPath,
      env: {
        ...environment,
        PATH: hostPath.length === 0 ? artifactBin : `${artifactBin}:${hostPath}`,
        POSTGRES_HOST: "127.0.0.1",
        POSTGRES_PORT: String(endpointPort),
        POSTGRES_DB: "postgres",
        POSTGRES_USER: "supabase_admin",
        POSTGRES_PASSWORD: environment.POSTGRES_PASSWORD ?? "",
      },
    };
  });

const bootstrapContent = Effect.tryPromise({
  try: () => bundleServeMainTemplate(),
  catch: (cause) => preparationError("Unable to bundle functions bootstrap", cause),
});

const mapDriverError = (
  key: Pick<RuntimeWorkloadKey, "stackId" | "workloadId">,
  error: unknown,
): RuntimeDriverError =>
  driverError(key, error instanceof Error ? error.message : "Runtime operation failed", error);

/** Ensures owner files are attempted even when the selected runtime cleanup fails. */
export const withOwnedRuntimeFileCleanup = (
  driver: RuntimeDriver,
  envFiles: RuntimeEnvFileOwner,
  functionsBootstrap: FunctionsBootstrapOwner,
  inputOwner?: RuntimeInputOwner,
): RuntimeDriver => {
  const cleanupFiles = (stackId: StackId): Effect.Effect<void, RuntimeDriverError> =>
    Effect.gen(function* () {
      const key = { stackId, workloadId: "" };
      let cleanupCause: Cause.Cause<RuntimeDriverError> = Cause.empty;
      const attempts = [
        envFiles.cleanupAll,
        functionsBootstrap.cleanupAll,
        ...(inputOwner === undefined ? [] : [inputOwner.cleanupAll]),
      ];
      for (const attempt of attempts) {
        const result = yield* Effect.exit(
          attempt.pipe(
            Effect.mapError((error) => driverError(key, "Unable to clean runtime files", error)),
          ),
        );
        if (Exit.isFailure(result)) cleanupCause = Cause.combine(cleanupCause, result.cause);
      }
      if (cleanupCause.reasons.length > 0) return yield* Effect.failCause(cleanupCause);
    });
  return {
    ...driver,
    cleanup: (request) =>
      Effect.gen(function* () {
        const runtime = yield* Effect.exit(driver.cleanup(request));
        const files = yield* Effect.exit(cleanupFiles(request.stackId));
        if (Exit.isFailure(runtime) && Exit.isFailure(files))
          return yield* Effect.failCause(Cause.combine(runtime.cause, files.cause));
        if (Exit.isFailure(runtime)) return yield* Effect.failCause(runtime.cause);
        if (Exit.isFailure(files)) return yield* Effect.failCause(files.cause);
      }),
  };
};

/** Composes concrete runtime owners around one persisted stack identity. */
export const makeProductionRuntimeFactory = (
  options: ProductionRuntimeFactoryOptions,
): Effect.Effect<
  SupervisorRuntimeFactory,
  StackError,
  | Scope.Scope
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const initial = yield* currentStateReader(options);
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const childSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const ownerScope = yield* Scope.Scope;
    const paths = yield* resolveStackPaths({
      stateRoot: options.stateRoot,
      stackId: options.stackId,
    }).pipe(
      Effect.mapError((error) => preparationError("Unable to resolve stack runtime paths", error)),
    );
    const fetchJson: RuntimeJsonFetcher =
      options.fetchJson ??
      ((url) =>
        // oxlint-disable effecttsgo/async-function -- production fetch leaf owns AbortSignal.
        // oxlint-disable effecttsgo/global-fetch-in-effect -- production fetch leaf is the network boundary.
        Effect.tryPromise({
          try: async (signal) => {
            const response = await fetch(url, { signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
          },
          catch: (cause) => preparationError("Unable to fetch Auth OIDC metadata", cause),
        }));
    // oxlint-enable effecttsgo/async-function
    // oxlint-enable effecttsgo/global-fetch-in-effect
    const inputOwnerScope = yield* Scope.fork(ownerScope, "sequential");
    const inputOwner = yield* makeRuntimeInputOwner({
      stateRoot: options.stateRoot,
      stackId: options.stackId,
      fetchJson,
    }).pipe(Effect.provideService(Scope.Scope, inputOwnerScope));
    yield* Scope.addFinalizer(
      ownerScope,
      Effect.gen(function* () {
        yield* Scope.close(inputOwnerScope, Exit.void);
        yield* inputOwner.cleanupAll.pipe(
          Effect.catchTag("StackPreparationError", () => Effect.void),
        );
      }),
    );
    // Register this child scope before constructing drivers: LIFO cleanup
    // stops workloads, closes owner fibers, then removes generated files.
    const registry = yield* makePortRegistry({
      stateRoot: options.stateRoot,
      store: options.stateStore,
    });
    const ingress =
      options.ingress ??
      (yield* makeSupervisorIngress({
        stackId: options.stackId,
        registry,
        store: options.stateStore,
        context: options.context,
        resolveAuthTemplates: inputOwner.resolveAuthTemplates,
      }));
    const envFiles =
      options.envFileOwner ??
      (yield* makeRuntimeEnvFileOwner({ stateRoot: options.stateRoot, stackId: options.stackId }));
    const functionsBootstrap =
      options.functionsBootstrapOwner ??
      (yield* makeFunctionsBootstrapOwner({
        stateRoot: options.stateRoot,
        stackId: options.stackId,
      }));
    const knownSecrets = yield* Ref.make<ReadonlySet<string>>(new Set(stateSecrets(initial)));
    const baseLogs =
      options.logStore ??
      (yield* makeLogStore({ path: paths.logs, knownSecrets: stateSecrets(initial) }).pipe(
        Effect.mapError((error) => preparationError("Unable to open stack logs", error)),
      ));
    const logs = dynamicLogStore(baseLogs, knownSecrets);
    const preparer =
      options.artifactPreparer ??
      (yield* makeProductionRuntimeArtifactPreparer({
        stateRoot: options.stateRoot,
        artifactCacheRoot: options.artifactCacheRoot,
        runtime: initial.runtime,
        platform: {
          os:
            process.platform === "darwin"
              ? "darwin"
              : process.platform === "win32"
                ? "windows"
                : "linux",
          desktop: process.platform === "darwin",
        },
      }));
    const containerEngine = options.containerEngine ?? preparer.containerEngine;
    const serveTemplate = yield* Effect.cached(bootstrapContent);
    const bootstrapDatabase =
      options.bootstrapDatabase ?? ((state: PersistedStackState) => bootstrapDatabaseAt(state));

    return {
      make: (state: PersistedStackState): Effect.Effect<SupervisorRuntime, StackError> =>
        Effect.gen(function* () {
          const artifacts = new Map<string, PreparedWorkloadArtifact>();
          const hostRoute = yield* Ref.make<ContainerHostRoute | undefined>(undefined);
          const bootstrapPaths = new Map<number, string>();

          const freshState = (key: Pick<RuntimeWorkloadKey, "stackId" | "workloadId">) =>
            currentStateReader(options).pipe(
              Effect.mapError((error) => mapDriverError(key, error)),
              Effect.flatMap((fresh) =>
                runtimeMatches(fresh.runtime, state.runtime)
                  ? Effect.succeed(fresh)
                  : Effect.fail(
                      driverError(key, "Persisted runtime changed while owner was active"),
                    ),
              ),
            );
          const prepare = (runtime: StackRuntime, workload: PlannedWorkload) => {
            const key = artifactKey(runtime, workload);
            const cached = artifacts.get(key);
            return cached === undefined
              ? preparer.prepare(runtime, workload).pipe(
                  Effect.mapError((error) =>
                    error instanceof ArtifactIntegrityError || error instanceof ContainerPullError
                      ? error
                      : preparationError(`Unable to prepare ${workload.id}`, error),
                  ),
                  Effect.tap((prepared) => Effect.sync(() => artifacts.set(key, prepared))),
                )
              : Effect.succeed(cached);
          };
          const prepareArtifacts = (
            runtime: StackRuntime,
            workloads: ReadonlyArray<PlannedWorkload>,
          ) =>
            Effect.forEach(workloads, (workload) => prepare(runtime, workload), {
              concurrency: 4,
            });
          const functionsPath = (
            generation: number,
          ): Effect.Effect<string, StackPreparationError> => {
            const cached = bootstrapPaths.get(generation);
            return cached === undefined
              ? Effect.gen(function* () {
                  const content = yield* serveTemplate;
                  const path = yield* functionsBootstrap.write({ generation, content });
                  bootstrapPaths.set(generation, path);
                  return path;
                })
              : Effect.succeed(cached);
          };
          const runtimeInputs = (
            workload: PlannedWorkload,
            fresh: PersistedStackState,
            generation: number,
            host: ContainerHostRoute | undefined,
          ): Effect.Effect<WorkloadRuntimeInputs, StackPreparationError> =>
            Effect.gen(function* () {
              const material = yield* inputOwner.resolve(fresh, generation, {
                includePooler: workload.id === "pooler:pooler",
              });
              const templates = material.auth?.templates;
              const apiListener = fresh.definition?.listeners.api;
              const apiAssignment = fresh.ports.find((assignment) => assignment.field === "api");
              const templateBaseUrl =
                workload.id !== "auth:auth" || templates === undefined || templates.length === 0
                  ? undefined
                  : apiListener?.enabled !== true || apiAssignment === undefined
                    ? yield* preparationError(
                        "Configured Auth email templates require a public API listener",
                      )
                    : `http://${urlHost(host?.host ?? apiListener.address)}:${apiAssignment.port}`;
              const auth =
                material.auth === undefined
                  ? undefined
                  : {
                      ...material.auth,
                      ...(templateBaseUrl === undefined ? {} : { templateBaseUrl }),
                    };
              const functions =
                workload.id === "functions:edge-runtime"
                  ? {
                      bootstrapPath: yield* functionsPath(generation),
                      bootstrapContainerPath: FUNCTIONS_BOOTSTRAP_CONTAINER_PATH,
                      ...(material.functions?.secrets === undefined
                        ? {}
                        : { secrets: material.functions.secrets }),
                    }
                  : undefined;
              return {
                ...(auth === undefined ? {} : { auth }),
                ...(workload.id.startsWith("analytics:") && material.analytics !== undefined
                  ? { analytics: material.analytics }
                  : {}),
                ...(workload.id === "pooler:pooler" && material.pooler !== undefined
                  ? { pooler: material.pooler }
                  : {}),
                database: { dataPath: pathService.join(paths.data, "database") },
                storage: { dataPath: pathService.join(paths.data, "storage") },
                ...(functions === undefined ? {} : { functions }),
                ...(host === undefined ? {} : { hostRoute: host }),
              };
            });

          const preflight = (input: LifecycleInput): Effect.Effect<LifecyclePrepared, StackError> =>
            Effect.gen(function* () {
              if (!runtimeMatches(input.state.runtime, state.runtime))
                return yield* new StackRuntimeMismatchError({
                  message: "Lifecycle runtime does not match persisted runtime",
                });
              // Remember candidate secrets before any runtime preflight work can emit logs.
              yield* rememberSecrets(knownSecrets, input.state.secrets);
              yield* rememberSecrets(knownSecrets, input.secrets);
              // Eagerly validate the candidate before any engine/artifact work. Start-time checks
              // below revalidate the fresh persisted definition because it is runtime authority.
              yield* validateDatabaseReadinessBudget(input.definition, input.plan.workloads);
              yield* Effect.forEach(input.plan.workloads, (workload) =>
                Effect.gen(function* () {
                  if (runtimeSpecFor(workload) === undefined)
                    return yield* preparationError(
                      `Unknown runtime specification for ${workload.id}`,
                    );
                  if (workload.selected.kind !== input.state.runtime.kind)
                    return yield* preparationError(`Runtime artifact mismatch for ${workload.id}`);
                }),
              );
              if (input.state.runtime.kind === "container") {
                if (
                  containerEngine === undefined ||
                  containerEngine.kind !== input.state.runtime.engine
                )
                  return yield* preparationError("Selected container engine is unavailable");
                const route = yield* containerEngine.preflight.pipe(
                  Effect.mapError((error) =>
                    preparationError("Container host route preflight failed", error),
                  ),
                );
                yield* Ref.set(hostRoute, route);
              }
              yield* prepareArtifacts(input.state.runtime, input.plan.workloads);
              return {};
            });

          const activate = (
            capability: import("../public/Capability.ts").CapabilityName,
            input: LifecycleInput,
          ): Effect.Effect<
            { readonly host: string; readonly port: number },
            GatewayActivationError | StackError
          > =>
            Effect.gen(function* () {
              const workload = input.plan.workloads.find(
                (entry) =>
                  entry.capability === capability && entry.readiness.portField !== undefined,
              );
              if (workload === undefined)
                return yield* new GatewayActivationError({
                  message: `Capability ${capability} has no workload`,
                });
              const fresh = yield* freshState({
                stackId: options.stackId,
                workloadId: workload.id,
              }).pipe(
                Effect.mapError((error) => new GatewayActivationError({ message: error.message })),
              );
              const spec = runtimeSpecFor(workload);
              if (spec === undefined)
                return yield* new GatewayActivationError({
                  message: `Unknown runtime specification for ${workload.id}`,
                });
              yield* validatePrivateAssignments(fresh, workload).pipe(
                Effect.mapError((error) => new GatewayActivationError({ message: error.message })),
              );
              const endpoint = spec.privateEndpoint(fresh, spec.readiness.binding, "native");
              if (endpoint === undefined)
                return yield* new GatewayActivationError({
                  message: `Missing private endpoint for ${workload.id}`,
                });
              return endpoint;
            });

          const waitForReadiness = (key: RuntimeWorkloadKey, workload: PlannedWorkload) =>
            freshState(key).pipe(
              Effect.flatMap((fresh) => readinessFor(fresh, workload)),
              Effect.mapError((error) => mapDriverError(key, error)),
            );
          const bootstrapWorkloadDatabase = (key: RuntimeWorkloadKey, workload: PlannedWorkload) =>
            workload.bootstrap === "database"
              ? freshState(key).pipe(
                  Effect.flatMap((fresh) =>
                    readinessDeadlineFor(fresh, workload).pipe(
                      Effect.flatMap((deadline) =>
                        Effect.timeout(
                          Effect.retry(
                            Effect.suspend(() => bootstrapDatabase(fresh)),
                            {
                              schedule: Schedule.spaced("100 millis"),
                              while: (error) =>
                                error instanceof DatabaseBootstrapError && error.retryable === true,
                            },
                          ),
                          deadline,
                        ),
                      ),
                    ),
                  ),
                  Effect.mapError((error) => mapDriverError(key, error)),
                )
              : Effect.void;

          let driver: RuntimeDriver;
          if (state.runtime.kind === "native") {
            driver = yield* makeNativeRuntime({
              resolveProcess: (key, workload) =>
                freshState(key).pipe(
                  Effect.flatMap((fresh) =>
                    Effect.gen(function* () {
                      const spec = runtimeSpecFor(workload);
                      if (spec === undefined)
                        return yield* driverError(
                          key,
                          `Unknown runtime specification for ${workload.id}`,
                        );
                      // Revalidate the fresh persisted definition before spawning; preflight checks
                      // the candidate definition, while this state is the runtime authority.
                      const readinessBudget = yield* readinessDeadlineFor(fresh, workload).pipe(
                        Effect.mapError((error) => mapDriverError(key, error)),
                      );
                      const inputs = yield* runtimeInputs(
                        workload,
                        fresh,
                        key.desiredGeneration,
                        undefined,
                      ).pipe(Effect.mapError((error) => mapDriverError(key, error)));
                      yield* validateWorkloadRuntimeInputs(fresh, workload, inputs).pipe(
                        Effect.mapError((error) => mapDriverError(key, error)),
                      );
                      yield* validatePrivateAssignments(fresh, workload).pipe(
                        Effect.mapError((error) => mapDriverError(key, error)),
                      );
                      const prepared = yield* prepare(fresh.runtime, workload).pipe(
                        Effect.mapError((error) => mapDriverError(key, error)),
                      );
                      if (prepared.artifactRoot === undefined)
                        return yield* driverError(
                          key,
                          `Native artifact root is unavailable for ${workload.id}`,
                        );
                      const endpoint = spec.privateEndpoint(
                        fresh,
                        spec.readiness.binding,
                        "native",
                      );
                      if (endpoint === undefined)
                        return yield* driverError(
                          key,
                          `Missing private port assignment for ${workload.id}`,
                        );
                      const resolvedNativeProcess = spec.nativeProcess(
                        prepared.artifactRoot,
                        fresh,
                        workload,
                        endpoint.port,
                        inputs,
                      );
                      const environment = spec.env(
                        fresh,
                        workload,
                        endpoint.port,
                        "native",
                        inputs,
                      );
                      let migration: NativeProcessSpec | undefined;
                      if (isDatabaseWorkload(workload)) {
                        const dataPath = inputs.database?.dataPath;
                        if (dataPath === undefined)
                          return yield* driverError(
                            key,
                            "Resolved database data path is unavailable for native migration",
                          );
                        migration = yield* prepareNativeDatabaseMigration({
                          key,
                          dataPath,
                          artifactRoot: prepared.artifactRoot,
                          environment,
                          endpointPort: endpoint.port,
                          timeout: readinessBudget,
                          fileSystem,
                          pathService,
                        });
                      }
                      return {
                        startup: spec
                          .nativeStartupProcesses(
                            prepared.artifactRoot,
                            fresh,
                            workload,
                            endpoint.port,
                            inputs,
                          )
                          .map((startup: NativeProcessSpec) => ({
                            ...startup,
                            timeout:
                              startup.timeout ??
                              (isDatabaseWorkload(workload)
                                ? readinessBudget
                                : Duration.minutes(5)),
                            env: { ...environment, ...startup.env },
                          })),
                        ...(migration === undefined ? {} : { postReadiness: [migration] }),
                        main: { ...resolvedNativeProcess, env: environment },
                      };
                    }),
                  ),
                ),
              waitForReadiness,
              bootstrapDatabase: bootstrapWorkloadDatabase,
              logStore: logs,
            }).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childSpawner),
              Effect.provideService(Scope.Scope, ownerScope),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, pathService),
              Effect.mapError((error) =>
                preparationError("Unable to initialize native runtime", error),
              ),
            );
          } else {
            if (containerEngine === undefined || containerEngine.kind !== state.runtime.engine)
              return yield* preparationError("Selected container engine is unavailable");
            driver = yield* makeContainerRuntime({
              engine: containerEngine,
              ownerSessionId: options.ownerSessionId,
              resolveWorkload: (key, workload) =>
                freshState(key).pipe(
                  Effect.flatMap((fresh) =>
                    Effect.gen(function* () {
                      const spec = runtimeSpecFor(workload);
                      if (spec === undefined)
                        return yield* driverError(
                          key,
                          `Unknown runtime specification for ${workload.id}`,
                        );
                      // Revalidate the fresh persisted definition before creating a container;
                      // preflight checks the candidate definition, while this state is authoritative.
                      yield* readinessDeadlineFor(fresh, workload).pipe(
                        Effect.mapError((error) => mapDriverError(key, error)),
                      );
                      let route = yield* Ref.get(hostRoute);
                      if (route === undefined) {
                        route = yield* containerEngine.preflight.pipe(
                          Effect.mapError((error) => mapDriverError(key, error)),
                        );
                        yield* Ref.set(hostRoute, route);
                      }
                      const inputs = yield* runtimeInputs(
                        workload,
                        fresh,
                        key.desiredGeneration,
                        route,
                      ).pipe(Effect.mapError((error) => mapDriverError(key, error)));
                      yield* validateWorkloadRuntimeInputs(fresh, workload, inputs).pipe(
                        Effect.mapError((error) => mapDriverError(key, error)),
                      );
                      const resolution = yield* resolveContainerResolutionFor(
                        fresh,
                        workload,
                        inputs,
                      ).pipe(Effect.mapError((error) => mapDriverError(key, error)));
                      if (resolution === undefined)
                        return yield* driverError(
                          key,
                          `Unknown container runtime specification for ${workload.id}`,
                        );
                      const envFile = yield* envFiles
                        .write({
                          generation: key.desiredGeneration,
                          workloadId: workload.id,
                          values: resolution.env,
                        })
                        .pipe(Effect.mapError((error) => mapDriverError(key, error)));
                      const volume =
                        workload.id === "database:database"
                          ? { target: "/var/lib/postgresql/data", readOnly: false }
                          : workload.id === "storage:storage"
                            ? {
                                target: "/mnt",
                                readOnly: false,
                                ownerWorkloadId: "storage:storage",
                              }
                            : workload.id === "storage:imgproxy"
                              ? {
                                  target: "/mnt",
                                  readOnly: true,
                                  ownerWorkloadId: "storage:storage",
                                }
                              : undefined;
                      const { env: _env, ...withoutEnv } = resolution;
                      return {
                        ...withoutEnv,
                        envFile,
                        waitForReadiness,
                        ...(volume === undefined ? {} : { volume }),
                      } satisfies ContainerWorkloadResolution;
                    }),
                  ),
                ),
              waitForReadiness,
              bootstrapDatabase: bootstrapWorkloadDatabase,
              logStore: logs,
            }).pipe(Effect.provideService(Scope.Scope, ownerScope));
          }
          const baseDriver = withOwnedRuntimeFileCleanup(
            driver,
            envFiles,
            functionsBootstrap,
            inputOwner,
          );
          const cleanupOwnedInputs = (key: RuntimeWorkloadKey) =>
            key.workloadId === "pooler:pooler"
              ? inputOwner
                  .cleanupGeneration(key.desiredGeneration, "pooler")
                  .pipe(
                    Effect.mapError((error) =>
                      driverError(key, "Unable to clean pooler runtime input", error),
                    ),
                  )
              : key.workloadId === "analytics:vector"
                ? inputOwner
                    .cleanupGeneration(key.desiredGeneration, "vector")
                    .pipe(
                      Effect.mapError((error) =>
                        driverError(key, "Unable to clean Vector runtime input", error),
                      ),
                    )
                : Effect.void;
          const ownedDriver: RuntimeDriver = {
            ...baseDriver,
            stop: (key) => baseDriver.stop(key).pipe(Effect.tap(() => cleanupOwnedInputs(key))),
            remove: (key) => baseDriver.remove(key).pipe(Effect.tap(() => cleanupOwnedInputs(key))),
          };
          return {
            driver: ownedDriver,
            prepare: prepareArtifacts,
            preflight,
            activate,
            ingress,
            logStore: logs,
          } satisfies SupervisorRuntime;
        }),
    } satisfies SupervisorRuntimeFactory;
  });
