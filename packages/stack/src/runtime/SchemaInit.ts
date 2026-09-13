import {
  Crypto,
  Duration,
  Effect,
  FileSystem,
  Path,
  Redacted,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { compileStack } from "../model/Compiler.ts";
import type {
  SchemaInitCapabilityName,
  SchemaInitOptions,
  SchemaInitTarget,
} from "../public/SchemaInit.ts";
import type { SchemaInitError } from "../public/Errors.ts";
import { StackIdSchema, type StackId } from "../public/StackId.ts";
import {
  ContainerEngineError,
  InvalidStackConfigError,
  InvalidStackIdentityError,
  RequiresActivatedProcessError,
  StackPreparationError,
  StackRuntimeError,
} from "../public/Errors.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import {
  AUTH_JWT_SECRET_SLOT,
  DATABASE_INTERNAL_PASSWORD_SLOT,
  resolveSecrets,
} from "../state/SecretStore.ts";
import { STACK_STATE_FORMAT, type PersistedStackState } from "../state/StackState.ts";
import { defaultRuntimeEnvironment } from "../supervisor/Launcher.ts";
import { makeProductionRuntimeArtifactPreparer } from "../preparation/RuntimeArtifacts.ts";
import { catalogReleaseFor } from "../model/WorkloadCatalog.ts";
import type { ContainerEngine, ContainerHostRoute } from "./ContainerEngine.ts";
import { resolveContainerEngine } from "./ContainerEngineResolver.ts";
import { runContainerStartupProcess, schemaInitContainerName } from "./ContainerRuntime.ts";
import {
  defaultNativeProcessLauncher,
  spawnNativeProcess,
  type NativeProcessSpec,
} from "./NativeProcess.ts";
import { makeRuntimeInputOwner } from "./RuntimeInputOwner.ts";
import { encodeRuntimeEnvFile } from "./RuntimeEnvFile.ts";
import type { RuntimeWorkloadKey } from "./RuntimeDriver.ts";
import {
  runtimeSpecFor,
  validateWorkloadRuntimeInputs,
  type WorkloadRuntimeInputs,
  type WorkloadRuntimeSpec,
} from "./WorkloadRuntimeSpec.ts";

const STARTUP_TIMEOUT = "5 minutes" satisfies Duration.Input;
const AUTH_TEMPLATE_BASE_URL = "http://127.0.0.1";

const PRIMARY_WORKLOAD: Record<SchemaInitCapabilityName, string> = {
  auth: "auth:auth",
  storage: "storage:storage",
  realtime: "realtime:realtime",
  analytics: "analytics:analytics",
  pooler: "pooler:pooler",
};

const SCHEMA_INIT_BINDINGS = ["primary", "admin", "ui", "smtp", "pop3", "inspector"] as const;

/** Catalog version and image for a schema-init one-shot; undefined when the pin is unknown. */
export const schemaInitArtifactIdentity = (
  name: SchemaInitCapabilityName,
  version?: string,
): string | undefined => {
  const release = catalogReleaseFor(PRIMARY_WORKLOAD[name], version);
  return release === undefined ? undefined : `${release.version}:${release.containerImage}`;
};

const schemaInitPrivatePorts = (
  databasePort: number,
  workloadId: string,
  bindings: WorkloadRuntimeSpec["bindings"],
): PersistedStackState["privatePorts"] => [
  { workloadId: "database:database", binding: "primary", port: databasePort },
  ...SCHEMA_INIT_BINDINGS.flatMap((binding) => {
    const bound = bindings[binding];
    return bound === undefined ? [] : [{ workloadId, binding, port: bound.containerPort }];
  }),
];

/** Linux Engine extra hosts so rewritten `host.docker.internal` URLs resolve. */
export const schemaInitHostGatewayExtraHosts = (
  platform: string,
  host: string,
): ReadonlyArray<string> =>
  platform === "linux" && host === "host.docker.internal"
    ? ["host.docker.internal:host-gateway"]
    : [];

const DATABASE_HOST_KEYS = new Set([
  "DB_HOST",
  "GOTRUE_DB_HOST",
  "POSTGRES_HOST",
  "PGHOST",
  "PG_META_DB_HOST",
]);
const DATABASE_PORT_KEYS = new Set([
  "DB_PORT",
  "GOTRUE_DB_PORT",
  "POSTGRES_PORT",
  "PGPORT",
  "PG_META_DB_PORT",
]);
const DATABASE_PASSWORD_KEYS = new Set([
  "DB_PASSWORD",
  "GOTRUE_DB_PASSWORD",
  "POSTGRES_PASSWORD",
  "PGPASSWORD",
  "PG_META_DB_PASSWORD",
]);
const CONNECTION_PROTOCOLS = new Set(["postgres:", "postgresql:", "ecto:"]);

export interface ParsedDatabaseUrl {
  readonly host: string;
  readonly port: number;
  readonly password: string;
  readonly database: string;
}

export const parseSchemaInitDatabaseUrl = (url: string): ParsedDatabaseUrl | undefined => {
  try {
    const parsed = new URL(url);
    if (!CONNECTION_PROTOCOLS.has(parsed.protocol)) return undefined;
    const port = Number.parseInt(parsed.port === "" ? "5432" : parsed.port, 10);
    if (!Number.isInteger(port) || parsed.hostname.length === 0) return undefined;
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    return {
      host: parsed.hostname,
      port,
      password: decodeURIComponent(parsed.password),
      database,
    };
  } catch {
    return undefined;
  }
};

const rewriteConnectionUrl = (
  value: string,
  target: { readonly host: string; readonly port: number; readonly password: string },
): string | undefined => {
  if (!value.includes("://")) return undefined;
  try {
    const parsed = new URL(value);
    if (!CONNECTION_PROTOCOLS.has(parsed.protocol)) return undefined;
    parsed.hostname = target.host;
    parsed.port = String(target.port);
    parsed.password = target.password;
    return parsed.toString();
  } catch {
    return undefined;
  }
};

/** Rewrites only host/port/password on database connection settings; keeps user and database name. */
export const rewriteDatabaseEnvironment = (
  env: Readonly<Record<string, string>>,
  target: { readonly host: string; readonly port: number; readonly password: string },
): Record<string, string> => {
  const rewritten: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (DATABASE_HOST_KEYS.has(key)) {
      rewritten[key] = target.host;
      continue;
    }
    if (DATABASE_PORT_KEYS.has(key)) {
      rewritten[key] = String(target.port);
      continue;
    }
    if (DATABASE_PASSWORD_KEYS.has(key)) {
      rewritten[key] = target.password;
      continue;
    }
    rewritten[key] = rewriteConnectionUrl(value, target) ?? value;
  }
  return rewritten;
};

const loopbackHost = (host: string): boolean => host === "127.0.0.1" || host === "localhost";

const schemaInitIdentity = (
  crypto: Crypto.Crypto,
): Effect.Effect<StackId, InvalidStackIdentityError> =>
  Effect.gen(function* () {
    const first = yield* crypto.randomUUIDv4;
    const second = yield* crypto.randomUUIDv4;
    return yield* Schema.decodeEffect(StackIdSchema)(`${first}${second}`.replaceAll("-", ""));
  }).pipe(
    Effect.mapError(
      (cause) =>
        new InvalidStackIdentityError({
          message: "Unable to allocate schema-init identity",
          cause,
        }),
    ),
  );

const runtimeError = (
  key: Pick<RuntimeWorkloadKey, "stackId" | "workloadId">,
  message: string,
  cause?: unknown,
): StackRuntimeError =>
  new StackRuntimeError({
    message,
    stackId: key.stackId,
    workloadId: key.workloadId,
    ...(cause === undefined ? {} : { cause }),
  });

const mapContainerEngineError = (
  engine: StackRuntime & { readonly kind: "container" },
  message: string,
  cause: unknown,
): ContainerEngineError =>
  new ContainerEngineError({
    engine: engine.engine,
    message,
    cause,
  });

const resolveEngine = (
  target: SchemaInitTarget,
  options: SchemaInitOptions,
): Effect.Effect<
  ContainerEngine | undefined,
  ContainerEngineError,
  ChildProcessSpawner.ChildProcessSpawner
> => {
  if (target.runtime.kind !== "container") return Effect.succeed(undefined);
  if (options.containerEngine !== undefined) return Effect.succeed(options.containerEngine);
  const runtime = target.runtime;
  return resolveContainerEngine(runtime.engine).pipe(
    Effect.mapError((cause) =>
      mapContainerEngineError(
        runtime,
        `Unable to configure ${runtime.engine} for schema init`,
        cause,
      ),
    ),
  );
};

const resolveLiveNetwork = (
  engine: ContainerEngine,
  stackId: StackId,
  runtime: StackRuntime & { readonly kind: "container" },
): Effect.Effect<string, ContainerEngineError | StackRuntimeError> =>
  engine.listResources(stackId).pipe(
    Effect.mapError((cause) =>
      mapContainerEngineError(runtime, "Unable to list stack resources for schema init", cause),
    ),
    Effect.flatMap((resources) => {
      const network = resources.find((entry) => entry.kind === "network");
      return network === undefined
        ? Effect.fail(
            runtimeError(
              { stackId, workloadId: "" },
              "Stack network is unavailable for schema init",
            ),
          )
        : Effect.succeed(network.id);
    }),
  );

const acquireEphemeralNetwork = (
  engine: ContainerEngine,
  schemaInitId: StackId,
  runtime: StackRuntime & { readonly kind: "container" },
): Effect.Effect<string, ContainerEngineError, Scope.Scope> =>
  Effect.gen(function* () {
    const created = yield* engine
      .createNetwork({
        name: `supabase-${schemaInitId.slice(0, 16)}-schema-init-net`,
        labels: {
          stackId: schemaInitId,
          ownerSessionId: schemaInitId.slice(0, 32),
          role: "network",
        },
      })
      .pipe(
        Effect.mapError((cause) =>
          mapContainerEngineError(runtime, "Unable to create schema-init network", cause),
        ),
      );
    yield* Effect.addFinalizer(() => engine.removeNetwork(created.id).pipe(Effect.ignore));
    return created.id;
  });

const runNativeStartup = (
  spec: NativeProcessSpec,
  key: RuntimeWorkloadKey,
): Effect.Effect<void, StackRuntimeError, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope> =>
  Effect.scoped(
    Effect.gen(function* () {
      const process = yield* spawnNativeProcess(spec, defaultNativeProcessLauncher(), key).pipe(
        Effect.mapError((error) => runtimeError(key, error.message, error)),
      );
      const drain = Effect.all([Stream.runDrain(process.stdout), Stream.runDrain(process.stderr)], {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.mapError((error) => runtimeError(key, error.message, error)));
      const exit = process.exitCode.pipe(
        Effect.mapError((error) => runtimeError(key, error.message, error)),
      );
      const [exitCode] = yield* Effect.all([exit, drain], { concurrency: "unbounded" }).pipe(
        Effect.timeoutOrElse({
          duration: spec.timeout ?? STARTUP_TIMEOUT,
          orElse: () =>
            Effect.fail(runtimeError(key, `Native schema init timed out for ${key.workloadId}`)),
        }),
      );
      if (exitCode !== 0)
        return yield* Effect.fail(
          runtimeError(
            key,
            `Native schema init exited with code ${String(exitCode)} for ${key.workloadId}`,
          ),
        );
    }),
  );

const capabilityInputs = (
  material: WorkloadRuntimeInputs,
  hostRoute: ContainerHostRoute | undefined,
): WorkloadRuntimeInputs => {
  const templateBaseUrl = material.auth?.templateBaseUrl ?? AUTH_TEMPLATE_BASE_URL;
  const auth = {
    ...material.auth,
    templateBaseUrl,
  };
  return {
    ...material,
    auth,
    ...(hostRoute === undefined ? {} : { hostRoute }),
  };
};

export const schemaInitWorkloads = (
  names: ReadonlyArray<SchemaInitCapabilityName>,
  target: SchemaInitTarget,
  options: SchemaInitOptions = {},
): Effect.Effect<
  void,
  SchemaInitError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const parsed = parseSchemaInitDatabaseUrl(target.databaseUrl);
      if (parsed === undefined)
        return yield* new InvalidStackConfigError({
          message: "Schema init requires a valid PostgreSQL URL",
        });
      const password = Redacted.value(target.secrets.databasePassword);
      const connection = { host: parsed.host, port: parsed.port, password };
      const compiled = yield* compileStack({
        projectRoot: target.projectRoot,
        runtime: target.runtime,
        config: target.config,
      });
      const declarations = compiled.secrets.map((entry) => {
        if (entry.slot === DATABASE_INTERNAL_PASSWORD_SLOT)
          return { ...entry, value: target.secrets.databasePassword };
        if (entry.slot === AUTH_JWT_SECRET_SLOT && target.secrets.jwtSecret !== undefined)
          return { ...entry, value: target.secrets.jwtSecret };
        return entry;
      });
      const resolved = yield* resolveSecrets({ declarations }, undefined, "unconfigured");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const schemaInitId = yield* schemaInitIdentity(crypto);
      const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-schema-init-" }).pipe(
        Effect.mapError(
          (cause) =>
            new StackPreparationError({
              message: "Unable to create schema-init workspace",
              cause,
            }),
        ),
      );
      const shared = yield* defaultRuntimeEnvironment;
      const engine = yield* resolveEngine(target, options);
      const preparer =
        options.artifactPreparer ??
        (yield* makeProductionRuntimeArtifactPreparer({
          stateRoot: shared.stateRoot,
          ...(shared.artifactCacheRoot === undefined
            ? {}
            : { artifactCacheRoot: shared.artifactCacheRoot }),
          runtime: target.runtime,
          ...(engine === undefined ? {} : { containerEngine: engine }),
        }));
      const inputOwner = yield* makeRuntimeInputOwner({
        stateRoot: tempRoot,
        stackId: schemaInitId,
      });
      yield* Effect.addFinalizer(() => inputOwner.cleanupAll.pipe(Effect.ignore));
      const envKind =
        target.runtime.kind === "container" && target.kind === "live" ? "container" : "native";
      const privatePorts: PersistedStackState["privatePorts"] = [
        { workloadId: "database:database", binding: "primary", port: connection.port },
      ];
      const state: PersistedStackState = {
        format: STACK_STATE_FORMAT,
        identity: {
          projectRoot: target.projectRoot,
          branchContext: "schema-init",
          stackName: "schema-init",
        },
        runtime: target.runtime,
        desiredLifecycle: "stopped",
        definition: compiled.definition,
        ports: [],
        privatePorts,
        secrets: resolved.persisted,
      };
      let hostRoute: ContainerHostRoute | undefined;
      let networkId: string | undefined;
      if (target.runtime.kind === "container") {
        const runtime = target.runtime;
        if (engine === undefined)
          return yield* new ContainerEngineError({
            engine: runtime.engine,
            message: "Container engine is unavailable for schema init",
          });
        hostRoute = yield* engine.preflight.pipe(
          Effect.mapError((cause) =>
            mapContainerEngineError(runtime, "Container host route preflight failed", cause),
          ),
        );
        networkId =
          target.kind === "live"
            ? yield* resolveLiveNetwork(engine, target.stackId, runtime)
            : yield* acquireEphemeralNetwork(engine, schemaInitId, runtime);
      }
      const rewriteTarget =
        target.runtime.kind === "container" && target.kind === "ephemeral"
          ? {
              host:
                hostRoute !== undefined && loopbackHost(connection.host)
                  ? hostRoute.host
                  : connection.host,
              port: connection.port,
              password,
            }
          : undefined;
      const extraHosts =
        rewriteTarget === undefined
          ? []
          : schemaInitHostGatewayExtraHosts(
              options.platform ?? process.platform,
              rewriteTarget.host,
            );
      yield* Effect.forEach(
        names,
        (name) =>
          Effect.gen(function* () {
            if (compiled.definition.capabilities[name].enabled !== true) return;
            const workloadId = PRIMARY_WORKLOAD[name];
            const workload = compiled.executionPlan.workloads.find(
              (entry) => entry.id === workloadId,
            );
            if (workload === undefined)
              return yield* Effect.fail(
                runtimeError(
                  { stackId: schemaInitId, workloadId },
                  `Missing planned workload for ${name} schema init`,
                ),
              );
            const spec = runtimeSpecFor(workload);
            if (spec === undefined)
              return yield* new StackPreparationError({
                message: `Unknown runtime specification for ${workload.id}`,
                workload: workload.id,
              });
            const key: RuntimeWorkloadKey = { stackId: schemaInitId, workloadId };
            const dummyPort = spec.containerPort;
            const envState: PersistedStackState = {
              ...state,
              privatePorts: schemaInitPrivatePorts(connection.port, workloadId, spec.bindings),
            };
            const material = yield* inputOwner.resolve(envState, workload.id);
            const inputs = capabilityInputs(material, hostRoute);
            yield* validateWorkloadRuntimeInputs(envState, workload, inputs);
            const environment = yield* Effect.try({
              try: () => spec.env(envState, workload, dummyPort, envKind, inputs),
              catch: (cause) =>
                runtimeError(key, cause instanceof Error ? cause.message : String(cause), cause),
            });
            const env =
              rewriteTarget === undefined
                ? environment
                : rewriteDatabaseEnvironment(environment, rewriteTarget);
            if (target.runtime.kind === "native") {
              const preview = spec.nativeStartupProcesses(
                "",
                envState,
                workload,
                dummyPort,
                inputs,
              );
              if (preview.length === 0)
                return yield* new RequiresActivatedProcessError({
                  capability: name,
                  message: `${name} schema init requires the activated ${name} process`,
                });
              const prepared = yield* preparer.prepare(target.runtime, workload);
              if (prepared.artifactRoot === undefined)
                return yield* Effect.fail(
                  runtimeError(key, `Native artifact root is unavailable for ${workload.id}`),
                );
              const startups = spec.nativeStartupProcesses(
                prepared.artifactRoot,
                envState,
                workload,
                dummyPort,
                inputs,
              );
              yield* Effect.forEach(
                startups,
                (startup) =>
                  runNativeStartup(
                    {
                      ...startup,
                      timeout: STARTUP_TIMEOUT,
                      env: { ...env, ...startup.env },
                    },
                    key,
                  ),
                { discard: true },
              );
              return;
            }
            const startups = spec.containerStartupProcesses(envState, workload, inputs);
            if (startups.length === 0)
              return yield* new RequiresActivatedProcessError({
                capability: name,
                message: `${name} schema init requires the activated ${name} process`,
              });
            if (engine === undefined || networkId === undefined)
              return yield* new ContainerEngineError({
                engine: target.runtime.kind === "container" ? target.runtime.engine : "docker",
                message: "Container engine is unavailable for schema init",
              });
            const prepared = yield* preparer.prepare(target.runtime, workload);
            if (prepared.image === undefined)
              return yield* Effect.fail(
                runtimeError(key, `Container image is unavailable for ${workload.id}`),
              );
            const encoded = yield* encodeRuntimeEnvFile(env);
            const envFile = path.join(tempRoot, `${encodeURIComponent(workload.id)}.env`);
            yield* fs.writeFileString(envFile, encoded).pipe(
              Effect.mapError(
                (cause) =>
                  new StackPreparationError({
                    message: "Unable to write schema-init environment file",
                    path: envFile,
                    cause,
                  }),
              ),
            );
            yield* fs.chmod(envFile, 0o600).pipe(
              Effect.mapError(
                (cause) =>
                  new StackPreparationError({
                    message: "Unable to secure schema-init environment file",
                    path: envFile,
                    cause,
                  }),
              ),
            );
            const image = prepared.image;
            const mounts = spec.containerMounts?.(envState, workload, inputs) ?? [];
            yield* Effect.forEach(
              startups,
              (startup) =>
                runContainerStartupProcess({
                  engine,
                  key,
                  timeout: STARTUP_TIMEOUT,
                  specification: {
                    name: schemaInitContainerName(key),
                    image,
                    labels: {
                      stackId: schemaInitId,
                      ownerSessionId: schemaInitId.slice(0, 32),
                      workloadId,
                      startup: true,
                      role: "workload",
                    },
                    network: networkId,
                    mounts,
                    volumeMounts: [],
                    publications: [],
                    role: "workload",
                    entrypoint: startup.entrypoint,
                    command: startup.command,
                    envFile,
                    ...(extraHosts.length === 0 ? {} : { extraHosts }),
                  },
                }).pipe(Effect.mapError((error) => runtimeError(key, error.message, error))),
              { discard: true },
            );
          }),
        { discard: true },
      );
    }),
  );
