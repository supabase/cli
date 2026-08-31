import { Cause, Context, Crypto, Effect, Exit, FileSystem, Path, Ref, Scope, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
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
import {
  LogStoreError,
  makeLogStore,
  type LogStore,
  type LogRecord,
} from "../supervisor/LogStore.ts";
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
import { probeReadiness } from "./ReadinessProbe.ts";
import type { ContainerEngine, ContainerHostRoute } from "./ContainerEngine.ts";
import { bootstrapDatabaseAt } from "./PostgresDatabaseSession.ts";
import type { DatabaseBootstrapError } from "../model/DatabaseBootstrap.ts";
import {
  RuntimeDriverError,
  type RuntimeDriver,
  type RuntimeWorkloadKey,
} from "./RuntimeDriver.ts";

type RuntimeContext = FileSystem.FileSystem | Path.Path | Crypto.Crypto;

export interface ProductionRuntimeFactoryOptions {
  readonly stateRoot: string;
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

const redactEntry = <A extends { readonly message: string }>(
  entry: A,
  secrets: ReadonlyArray<string>,
): A => {
  const message = redactKnownSecrets(entry.message, secrets);
  return message === entry.message ? entry : { ...entry, message };
};

/** Re-reads secret slots before each log operation so values materialized after startup are safe. */
const dynamicLogStore = (
  base: LogStore,
  readState: () => Effect.Effect<PersistedStackState, StackError>,
): LogStore => {
  const secrets = readState().pipe(
    Effect.map(stateSecrets),
    Effect.mapError(
      () => new LogStoreError({ path: base.path, message: "Unable to read current stack secrets" }),
    ),
  );
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
    retained: (options) =>
      secrets.pipe(
        Effect.flatMap((known) =>
          base
            .retained(options)
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
  return probeReadiness({
    mode: spec.readiness.protocol,
    host: "127.0.0.1",
    port: endpoint.port,
    ...(spec.readiness.path === undefined ? {} : { path: spec.readiness.path }),
    ...(spec.readiness.headers === undefined ? {} : { headers: spec.readiness.headers }),
  });
};

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
    const baseLogs =
      options.logStore ??
      (yield* makeLogStore({ path: paths.logs, knownSecrets: stateSecrets(initial) }).pipe(
        Effect.mapError((error) => preparationError("Unable to open stack logs", error)),
      ));
    const logs = dynamicLogStore(baseLogs, () => currentStateReader(options));
    const preparer =
      options.artifactPreparer ??
      (yield* makeProductionRuntimeArtifactPreparer({
        stateRoot: options.stateRoot,
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
                ...(workload.id === "analytics:analytics" && material.analytics !== undefined
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
              yield* Effect.forEach(input.plan.workloads, (workload) =>
                Effect.gen(function* () {
                  if (runtimeSpecFor(workload) === undefined)
                    return yield* preparationError(
                      `Unknown runtime specification for ${workload.id}`,
                    );
                  if (workload.selected.kind !== input.state.runtime.kind)
                    return yield* preparationError(`Runtime artifact mismatch for ${workload.id}`);
                  yield* prepare(input.state.runtime, workload);
                }),
              );
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
                (entry) => entry.capability === capability,
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
                      const process = spec.nativeProcess(
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
                      return {
                        startup: spec
                          .nativeStartupProcesses(
                            prepared.artifactRoot,
                            fresh,
                            workload,
                            endpoint.port,
                            inputs,
                          )
                          .map((startup) => ({
                            ...startup,
                            env: { ...environment, ...startup.env },
                          })),
                        main: { ...process, env: environment },
                      };
                    }),
                  ),
                ),
              waitForReadiness: (key, workload) =>
                freshState(key).pipe(
                  Effect.flatMap((fresh) => readinessFor(fresh, workload)),
                  Effect.mapError((error) => mapDriverError(key, error)),
                ),
              bootstrapDatabase: (key, workload) =>
                workload.bootstrap === "database"
                  ? freshState(key).pipe(
                      Effect.flatMap((fresh) => bootstrapDatabase(fresh)),
                      Effect.mapError((error) => mapDriverError(key, error)),
                    )
                  : Effect.void,
              logStore: logs,
            }).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childSpawner),
              Effect.provideService(Scope.Scope, ownerScope),
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
                        waitForReadiness: (resourceKey, resourceWorkload) =>
                          freshState(resourceKey).pipe(
                            Effect.flatMap((current) => readinessFor(current, resourceWorkload)),
                            Effect.mapError((error) => mapDriverError(resourceKey, error)),
                          ),
                        ...(volume === undefined ? {} : { volume }),
                      } satisfies ContainerWorkloadResolution;
                    }),
                  ),
                ),
              waitForReadiness: (key, workload) =>
                freshState(key).pipe(
                  Effect.flatMap((fresh) => readinessFor(fresh, workload)),
                  Effect.mapError((error) => mapDriverError(key, error)),
                ),
              bootstrapDatabase: (key, workload) =>
                workload.bootstrap === "database"
                  ? freshState(key).pipe(
                      Effect.flatMap((fresh) => bootstrapDatabase(fresh)),
                      Effect.mapError((error) => mapDriverError(key, error)),
                    )
                  : Effect.void,
              logStore: logs,
            }).pipe(Effect.provideService(Scope.Scope, ownerScope));
          }
          const baseDriver = withOwnedRuntimeFileCleanup(
            driver,
            envFiles,
            functionsBootstrap,
            inputOwner,
          );
          const ownedDriver: RuntimeDriver = {
            ...baseDriver,
            stop: (key) =>
              baseDriver
                .stop(key)
                .pipe(
                  Effect.tap(() =>
                    key.workloadId === "pooler:pooler"
                      ? inputOwner
                          .cleanupGeneration(key.desiredGeneration)
                          .pipe(
                            Effect.mapError((error) =>
                              driverError(key, "Unable to clean pooler runtime input", error),
                            ),
                          )
                      : Effect.void,
                  ),
                ),
            remove: (key) =>
              baseDriver
                .remove(key)
                .pipe(
                  Effect.tap(() =>
                    key.workloadId === "pooler:pooler"
                      ? inputOwner
                          .cleanupGeneration(key.desiredGeneration)
                          .pipe(
                            Effect.mapError((error) =>
                              driverError(key, "Unable to clean pooler runtime input", error),
                            ),
                          )
                      : Effect.void,
                  ),
                ),
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
