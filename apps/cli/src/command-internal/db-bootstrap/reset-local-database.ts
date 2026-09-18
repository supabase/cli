/**
 * Resets the local database in-process — shared by `db reset`'s handler and the `db schema
 * declarative`/`sync` local-reset paths, so neither needs to shell out to a separate process.
 * `db reset`'s own handler is the only caller that ever passes a non-empty
 * `version`/`seedFlags` override; the declarative callers always want the plain full reset.
 *
 * Always prints its own two stderr lines via `output.raw`, regardless of `output.format`, but
 * never the JSON `output.success(...)` envelope — that belongs to a top-level `db reset`
 * invocation only, emitted by its own handler after calling this function.
 */

import { Cause, Data, Effect, Exit, FileSystem, Option, Path, Redacted } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { detectGitBranch } from "../../shared/git/git-branch.ts";
import {
  DebugFlag,
  NetworkIdFlag,
  resolveExperimentalWithProjectEnv,
  resolveYesWithProjectEnv,
} from "../global-flags.ts";
import { Output } from "../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";
import { aqua, yellow } from "../colors.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import {
  checkDbToml,
  loadProjectEnv,
  readDbToml,
  type DbTomlValues,
} from "../db-config.toml-read.ts";
import { DbConnection, type PgConnInput } from "../db-connection.service.ts";
import { loadLocalProjectContext } from "../local-project-context.ts";
import { migrateAndSeed } from "../migrate-and-seed.ts";
import { hasConfiguredBuckets, seedBucketsRun } from "../seed-buckets.ts";
import { awaitStorageReady } from "./await-storage-ready.ts";
import { resolveResetSeedConfig } from "./db-setup.ts";
import { isLocalDbRunning } from "./local-db-running.ts";
import { recreateLocalDatabase, resetRecreateDatabases } from "./recreate-local-database.ts";
import { currentStackBackend } from "../stack-backend.ts";
import { optionalCatalogConfigFromStatus, stackOpenReadyProject } from "../stack-local-database.ts";
import {
  classifyStorageCapability,
  describeStorageCapability,
  StackStorageCapabilityError,
  StackStorageUnavailableError,
  stackStorageEndpointFor,
} from "../stack-storage.ts";
import { loadStackConfig } from "../stack-config.ts";
import { StackCatalogSetup } from "../stack-catalog-setup.ts";
import {
  buildLocalDbContainerInputs,
  type LocalDbContainerInputs,
} from "./local-container-inputs.ts";
import { shadowRunInputFromLocalContainerInputs } from "./shadow-database.ts";
import { stackWithShadowDatabase } from "../stack-shadow.ts";
import type { EffectStack, ServiceInstanceId, StackRuntime } from "@supabase/stack/effect";
import { rewriteDumpHostForToolContainer } from "../postgres-client.run.ts";
import { BundledPostgresClient, bundledPostgresClientRuntime } from "../bundled-postgres-client.ts";
import { RESERVED_ROLES, toDumpEnv } from "../pg-dump.env.ts";
import { parseConnectionString } from "../db-config.parse.ts";
import { splitAndTrim } from "../sql-split.ts";

const stackCredential = (value: string | Redacted.Redacted<string>): string =>
  typeof value === "string" ? value : Redacted.value(value);

const CREATE_ROLE_STATEMENT =
  /^\s*(?:(?:--[^\r\n]*(?:\r\n|\r|\n|$))|(?:\/\*[\s\S]*?\*\/\s*))*CREATE\s+(?:ROLE|USER)\s+(?:"((?:[^"]|"")*)"|([A-Za-z_][A-Za-z0-9_$]*))/i;
const managedRolePatterns = RESERVED_ROLES.map((pattern) => new RegExp(`^${pattern}$`));

const roleNamesToReset = (sql: string): ReadonlyArray<string> => {
  const names: Array<string> = [];
  for (const statement of splitAndTrim(sql)) {
    const match = CREATE_ROLE_STATEMENT.exec(statement);
    const quoted = match?.[1];
    const unquoted = match?.[2];
    const name = quoted === undefined ? unquoted?.toLowerCase() : quoted.replaceAll('""', '"');
    if (name !== undefined && !managedRolePatterns.some((pattern) => pattern.test(name)))
      names.push(name);
  }
  return [...new Set(names)];
};

const readRoleNamesToReset = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
) {
  const rolesPath = path.join(workdir, "supabase", "roles.sql");
  const exists = yield* fs
    .exists(rolesPath)
    .pipe(Effect.mapError((cause) => resetFailed(`failed to check roles.sql: ${cause.message}`)));
  if (!exists) return [];
  const sql = yield* fs
    .readFileString(rolesPath)
    .pipe(Effect.mapError((cause) => resetFailed(`failed to read roles.sql: ${cause.message}`)));
  return roleNamesToReset(sql);
});

const dropRole = (name: string): string => `DROP ROLE IF EXISTS "${name.replaceAll('"', '""')}"`;

/** Shell script that streams a plain logical dump into the target database. */
export const restoreStackLogicalBaselineScript = (): string =>
  [
    "set -euo pipefail",
    'pg_dump --format=plain | PGPASSWORD="$TARGET_PASSWORD" PGHOST="$TARGET_HOST" PGPORT="$TARGET_PORT" PGUSER="$TARGET_USER" PGDATABASE="$TARGET_DATABASE" psql --no-password --no-psqlrc -v ON_ERROR_STOP=1',
  ].join("\n");

/** Runs a plain logical dump from the baseline instance directly into the primary endpoint. */
const restoreStackLogicalBaseline = Effect.fnUntraced(function* (input: {
  readonly source: PgConnInput;
  readonly target: PgConnInput;
  readonly version: string;
  readonly runtime: StackRuntime;
  readonly platform: string;
  readonly extraHosts: ReadonlyArray<string>;
  readonly arch?: string;
}) {
  const script = restoreStackLogicalBaselineScript();
  const clientRuntime =
    bundledPostgresClientRuntime(input.runtime, input.platform, input.arch) ?? input.runtime;
  const source =
    clientRuntime.kind === "container"
      ? {
          ...input.source,
          host: rewriteDumpHostForToolContainer(input.source.host, {
            platform: input.platform,
            usesHostNetwork: true,
          }),
        }
      : input.source;
  const target =
    clientRuntime.kind === "container"
      ? {
          ...input.target,
          host: rewriteDumpHostForToolContainer(input.target.host, {
            platform: input.platform,
            usesHostNetwork: true,
          }),
        }
      : input.target;
  const clientEnv = {
    ...toDumpEnv(source),
    TARGET_HOST: target.host,
    TARGET_PORT: String(target.port),
    TARGET_USER: target.user,
    TARGET_PASSWORD: target.password,
    TARGET_DATABASE: target.database,
  };
  const bundled = yield* BundledPostgresClient;
  const result = yield* bundled
    .run({
      version: input.version,
      runtime: clientRuntime,
      argv: ["bash", "-c", script, "--"],
      env: clientEnv,
      network: "host",
      extraHosts: input.extraHosts,
      onStdout: () => Effect.void,
      teeStderr: true,
    })
    .pipe(
      Effect.mapError((cause) =>
        resetFailed(`failed to restore stack database baseline: ${cause.message}`),
      ),
    );
  if (result.exitCode !== 0)
    return yield* Effect.fail(
      new ResetLocalDbFailedError({
        message: `failed to restore stack database baseline: exit ${result.exitCode}${result.stderr.trim().length > 0 ? `: ${result.stderr.trim()}` : ""}`,
      }),
    );
});

/** The local database container is not running. */
class ResetLocalDbNotRunningError extends Data.TaggedError("ResetLocalDbNotRunningError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

class ResetLocalDbFailedError extends Data.TaggedError("ResetLocalDbFailedError")<{
  readonly message: string;
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbConnection;
  }
}

/** ` to version: X`, or `...` when resetting to the latest migration. */
const toLogMessage = (version: string): string =>
  version.length > 0 ? ` to version: ${version}` : "...";

export interface ResetLocalDatabaseInput {
  /** The resolved reset migration version (`""` for every pending migration, `db reset`'s default). */
  readonly version: string;
  /** `db reset`'s `--no-seed`/`--sql-paths` — see `resolveResetSeedConfig`. */
  readonly seedFlags: { readonly noSeed: boolean; readonly sqlPaths: ReadonlyArray<string> };
}

const PLAIN_FULL_RESET: ResetLocalDatabaseInput = {
  version: "",
  seedFlags: { noSeed: false, sqlPaths: [] },
};

const notRunning = () =>
  new ResetLocalDbNotRunningError({
    message: `${aqua("supabase start")} is not running.`,
  });

const resetFailed = (message: string) => new ResetLocalDbFailedError({ message });

const suggestionOf = (error: unknown): string | undefined =>
  error instanceof StackStorageUnavailableError || error instanceof StackStorageCapabilityError
    ? error.suggestion
    : undefined;

const resumeDependents = (stack: EffectStack, ids: ReadonlyArray<ServiceInstanceId>) =>
  stack.start({ services: ids }).pipe(
    Effect.asVoid,
    Effect.mapError((cause) =>
      resetFailed(`failed to resume dependent instances [${ids.join(", ")}]: ${cause.message}`),
    ),
  );

const resetStackDatabase = Effect.fnUntraced(function* (input: {
  readonly stack: EffectStack;
  readonly localInputs: LocalDbContainerInputs;
  readonly image: string;
  readonly toml: DbTomlValues;
  readonly platform: string;
  readonly arch?: string;
}) {
  const dbConn = yield* DbConnection;
  const primary = yield* input.stack.services
    .get({ name: "database" })
    .pipe(
      Effect.mapError((cause) =>
        resetFailed(`failed to resolve primary database: ${cause.message}`),
      ),
    );
  if (primary.service !== "database")
    return yield* resetFailed("the designated primary service is not a database");
  const primaryDescriptor = yield* primary.describe.pipe(
    Effect.mapError((cause) => resetFailed(`failed to inspect primary database: ${cause.message}`)),
  );
  const primaryMajor = Number.parseInt(primaryDescriptor.config.version.split(".")[0] ?? "", 10);
  if (!Number.isInteger(primaryMajor))
    return yield* resetFailed("primary database has no valid resolved Postgres version");

  const descriptors = yield* input.stack.services.list.pipe(
    Effect.mapError((cause) => resetFailed(`failed to inspect stack services: ${cause.message}`)),
  );
  const byId = new Map<string, (typeof descriptors)[number]>();
  for (const descriptor of descriptors) byId.set(descriptor.id, descriptor);
  const dependentIds = new Set<ServiceInstanceId>();
  const dependsOnPrimary = (id: string, visiting: Set<string>): boolean => {
    if (visiting.has(id)) return false;
    visiting.add(id);
    const descriptor = byId.get(id);
    if (descriptor === undefined) return false;
    return Object.values(descriptor.dependencies).some(
      (dependencyId) =>
        dependencyId === primary.id || dependsOnPrimary(dependencyId, new Set(visiting)),
    );
  };
  for (const descriptor of descriptors) {
    if (descriptor.id !== primary.id && dependsOnPrimary(descriptor.id, new Set()))
      dependentIds.add(descriptor.id);
  }
  const status = yield* input.stack.status.pipe(
    Effect.mapError((cause) => resetFailed(`failed to inspect stack: ${cause.message}`)),
  );
  const resumeIds = status.instances
    .filter((instance) => dependentIds.has(instance.id) && instance.intent === "started")
    .map((instance) => instance.id);
  const primaryCredentials = yield* primary.credentials.pipe(
    Effect.mapError((cause) => resetFailed(`failed to read primary credentials: ${cause.message}`)),
  );
  if (primaryCredentials === undefined)
    return yield* resetFailed("primary database credentials are unavailable");
  const primaryConn = parseConnectionString(stackCredential(primaryCredentials.url));
  if (primaryConn === undefined) return yield* resetFailed("failed to parse primary database URL");
  const primaryConfig = {
    version: primaryDescriptor.config.version,
    activation: primaryDescriptor.config.activation,
    settings: primaryDescriptor.config.settings,
  };
  // Disable background workers while DROP DATABASE tears down extensions such as pg_net.
  const maintenanceConfig = {
    ...primaryConfig,
    settings: {
      ...primaryConfig.settings,
      settings: {
        ...primaryConfig.settings.settings,
        max_worker_processes: 0,
      },
    },
  };
  const baselineLocalInputs: LocalDbContainerInputs = {
    ...input.localInputs,
    postgresSpecBase: {
      ...input.localInputs.postgresSpecBase,
      db: {
        ...input.localInputs.postgresSpecBase.db,
        major_version: primaryMajor,
        settings: primaryDescriptor.config.settings.settings,
      },
    },
    setup: {
      ...input.localInputs.setup,
      majorVersion: primaryMajor,
    },
  };
  const baselineInput = shadowRunInputFromLocalContainerInputs(
    baselineLocalInputs,
    input.image,
    {
      shadowPort: input.toml.shadowPort,
      password: stackCredential(primaryCredentials.password),
      webhooksEnabled: input.toml.webhooksEnabled,
      baseline: input.toml.baseline,
      vault: input.toml.vault,
    },
    yield* FileSystem.FileSystem,
    yield* Path.Path,
  );

  const reset = stackWithShadowDatabase(
    baselineInput,
    (shadow) => {
      const destructive = Effect.gen(function* () {
        const baselineDescriptor = yield* shadow.service.describe.pipe(
          Effect.mapError((cause) =>
            resetFailed(`failed to inspect database baseline: ${cause.message}`),
          ),
        );
        if (
          baselineDescriptor.initializationProfileId !== primaryDescriptor.initializationProfileId
        )
          return yield* resetFailed(
            "database baseline initialization does not match the primary instance",
          );
        const sourceCredentials = yield* shadow.service.credentials.pipe(
          Effect.mapError((cause) =>
            resetFailed(`failed to read baseline credentials: ${cause.message}`),
          ),
        );
        if (sourceCredentials === undefined)
          return yield* resetFailed("baseline database credentials are unavailable");
        const sourceConn = parseConnectionString(stackCredential(sourceCredentials.url));
        if (sourceConn === undefined)
          return yield* resetFailed("failed to parse baseline database URL");
        const rolesToReset = yield* readRoleNamesToReset(
          yield* FileSystem.FileSystem,
          yield* Path.Path,
          input.localInputs.containerOpts.workdir,
        );

        if (resumeIds.length > 0) {
          yield* input.stack
            .stop({ services: resumeIds })
            .pipe(
              Effect.mapError((cause) =>
                resetFailed(`failed to stop database dependents: ${cause.message}`),
              ),
            );
        }
        const restorePrimaryConfig = primary.restart({ config: primaryConfig }).pipe(
          Effect.asVoid,
          Effect.mapError((cause) =>
            resetFailed(`failed to restore primary database settings: ${cause.message}`),
          ),
        );
        const resetWithWorkersDisabled = Effect.gen(function* () {
          yield* primary.restart({ config: maintenanceConfig }).pipe(
            Effect.asVoid,
            Effect.mapError((cause) =>
              resetFailed(`failed to prepare primary database reset: ${cause.message}`),
            ),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const maintenance = yield* dbConn.connect(
                { ...primaryConn, user: "supabase_admin", database: "template1" },
                { isLocal: true, dnsResolver: "native" },
              );
              yield* resetRecreateDatabases(maintenance).pipe(
                Effect.mapError((cause) =>
                  resetFailed(`failed to recreate primary databases: ${cause.message}`),
                ),
              );
              for (const role of rolesToReset) {
                yield* maintenance
                  .exec(dropRole(role))
                  .pipe(
                    Effect.mapError((cause) =>
                      resetFailed(`failed to reset role ${role}: ${cause.message}`),
                    ),
                  );
              }
            }),
          );
          for (const database of ["postgres", "_supabase"] as const) {
            yield* restoreStackLogicalBaseline({
              source: { ...sourceConn, database },
              // The logical dump preserves managed object owners and ACLs. The database role
              // cannot SET ROLE to supabase_admin, so restore through the managed superuser
              // while retaining the primary database password.
              target: { ...primaryConn, user: "supabase_admin", database },
              version: baselineDescriptor.config.version,
              runtime: shadow.runtime,
              platform: input.platform,
              extraHosts: input.localInputs.containerOpts.extraHosts,
              arch: input.arch,
            });
          }
        }).pipe(Effect.onExit(() => restorePrimaryConfig));
        yield* resetWithWorkersDisabled;
      });
      return destructive;
    },
    {
      bypassCache: true,
      applyOverlay: false,
      database: {
        version: primaryDescriptor.config.version,
        settings: primaryDescriptor.config.settings,
        initialization: { from: primary.id },
      },
    },
  );
  yield* reset.pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        resumeIds.length === 0
          ? Effect.failCause(cause)
          : Effect.exit(resumeDependents(input.stack, resumeIds)).pipe(
              Effect.flatMap((resumed) =>
                Exit.isSuccess(resumed)
                  ? Effect.failCause(cause)
                  : Effect.failCause(Cause.combine(cause, resumed.cause)),
              ),
            ),
      onSuccess: Effect.succeed,
    }),
  );
  return resumeIds;
});

/** Resets the local database in-process. See this module's own header for the full design rationale. */
export const resetLocalDatabase = Effect.fnUntraced(function* (
  input: ResetLocalDatabaseInput = PLAIN_FULL_RESET,
) {
  const backend = yield* currentStackBackend;
  const output = yield* Output;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const workdir = cliSettings.workdir;
  // Load the project env first so a `SUPABASE_EXPERIMENTAL` set only in `supabase/.env` is
  // honored by the experimental gate below.
  const projectEnv = yield* loadProjectEnv(fs, path, workdir);
  const yes = yield* resolveYesWithProjectEnv(projectEnv);
  const experimental = yield* resolveExperimentalWithProjectEnv(projectEnv);

  // Abort on a bad config before wiping the local database.
  yield* checkDbToml(fs, path, workdir);

  if (backend.kind === "stack") {
    const opened = yield* stackOpenReadyProject;
    if (Option.isNone(opened))
      return yield* Effect.fail(
        new ResetLocalDbNotRunningError({ message: "The local stack is not running." }),
      );
    const catalog = yield* Effect.serviceOption(StackCatalogSetup);
    if (Option.isNone(catalog)) return yield* resetFailed("stack catalog setup is unavailable");
    const stackConfig = yield* loadStackConfig(workdir).pipe(
      Effect.mapError((cause) => resetFailed(cause.message)),
    );
    const toml = yield* readDbToml(fs, path, workdir);
    const runningStatus = yield* opened.value.stack.status.pipe(
      Effect.mapError((cause) => resetFailed(`failed to inspect stack: ${cause.message}`)),
    );
    const optionalConfig = optionalCatalogConfigFromStatus(stackConfig, runningStatus);
    yield* output.raw(`Resetting local database${toLogMessage(input.version)}\n`, "stderr");
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeInfo = yield* RuntimeInfo;
    const networkIdFlag = yield* NetworkIdFlag;
    const debug = yield* DebugFlag;
    const localInputs = yield* buildLocalDbContainerInputs(
      spawner,
      workdir,
      networkIdFlag,
      runtimeInfo.platform,
      debug,
    );
    const resolvedImage = yield* localInputs.resolvePostgresImage;
    const resumeIds = yield* resetStackDatabase({
      stack: opened.value.stack,
      localInputs,
      image: resolvedImage,
      toml,
      platform: runtimeInfo.platform,
      arch: runtimeInfo.arch,
    });
    const primary = yield* opened.value.stack.services
      .get({ name: "database" })
      .pipe(
        Effect.mapError((cause) =>
          resetFailed(`failed to resolve primary database: ${cause.message}`),
        ),
      );
    if (primary.service !== "database")
      return yield* resetFailed("the designated primary service is not a database");
    const dbConn = yield* DbConnection;
    const credentials = yield* primary.credentials.pipe(
      Effect.mapError((cause) =>
        resetFailed(`failed to read primary credentials: ${cause.message}`),
      ),
    );
    if (credentials === undefined)
      return yield* resetFailed("primary database credentials are unavailable");
    const conn = parseConnectionString(stackCredential(credentials.url));
    if (conn === undefined) return yield* resetFailed("failed to parse primary database URL");
    const overlayAndMigrate = Effect.gen(function* () {
      yield* catalog.value
        .apply({
          target: {
            kind: "service",
            stack: opened.value.stack,
            service: primary,
            projectRoot: workdir,
            config: stackConfig,
          },
          optionalConfig,
          overlay: {
            webhooks: "config",
            webhooksEnabled: toml.webhooksEnabled,
            apiAutoExposeNewTables: toml.baseline.apiAutoExposeNewTables,
            vault: toml.vault,
            workdir,
          },
        })
        .pipe(Effect.mapError((cause) => resetFailed(cause.message)));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* dbConn
            .connect(conn, { isLocal: true, dnsResolver: "native" })
            .pipe(
              Effect.mapError((cause) =>
                resetFailed(`failed to connect after reset: ${cause.message}`),
              ),
            );
          yield* migrateAndSeed(session, fs, path, workdir, input.version, {
            migrationsEnabled: toml.migrationsEnabled,
            seed: resolveResetSeedConfig(toml.seed, input.seedFlags, path),
            experimental,
            pgDeltaEnabled: toml.pgDelta.enabled,
            schemaPaths: toml.schemaPaths,
            localDatabaseWebhooksEnabled: toml.webhooksEnabled,
          }).pipe(Effect.mapError((cause) => resetFailed(cause.message)));
        }),
      );
    });
    yield* overlayAndMigrate.pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          resumeIds.length === 0
            ? Effect.failCause(cause)
            : Effect.exit(resumeDependents(opened.value.stack, resumeIds)).pipe(
                Effect.flatMap((resumed) =>
                  Exit.isSuccess(resumed)
                    ? Effect.failCause(cause)
                    : Effect.failCause(Cause.combine(cause, resumed.cause)),
                ),
              ),
        onSuccess: Effect.succeed,
      }),
    );
    if (resumeIds.length > 0) yield* resumeDependents(opened.value.stack, resumeIds);
    const inspectStatus = opened.value.stack.status.pipe(
      Effect.mapError((cause) =>
        resetFailed(`failed to inspect stack after reset: ${cause.message}`),
      ),
    );
    const status = yield* inspectStatus;
    const skipSeeding = (
      reason: string,
      nextStep = "Run supabase seed buckets --local once Storage is available.",
    ) =>
      output.raw(
        `${yellow("WARNING:")} skipped seeding storage buckets: ${reason} ${nextStep}\n`,
        "stderr",
      );
    const capability = status.capabilities.find((entry) => entry.name === "storage");
    yield* Effect.gen(function* () {
      const context = yield* loadLocalProjectContext(workdir, (message) => resetFailed(message));
      if (!hasConfiguredBuckets(context.config)) return;
      const decision = classifyStorageCapability(capability);
      if (decision !== "proceed") {
        yield* skipSeeding(
          describeStorageCapability(capability),
          decision === "disabled"
            ? "Set [storage] enabled = true in supabase/config.toml, run supabase stack stop followed by supabase stack start without -x storage, then supabase seed buckets --local."
            : undefined,
        );
        return;
      }
      const credentials = yield* stackStorageEndpointFor(opened.value.stack, status);
      yield* seedBucketsRun({
        projectRef: "",
        emitSummary: false,
        interactive: false,
        yes,
        credentials,
        resolvedConfig: { config: context.config, document: context.loaded?.document },
        projectEnvValues: projectEnv,
        workdir,
      });
    }).pipe(Effect.catch((error) => skipSeeding(error.message, suggestionOf(error))));
    const branch = Option.getOrElse(yield* detectGitBranch(workdir), () => "main");
    yield* output.raw(
      `Finished ${aqua("supabase db reset")} on branch ${aqua(branch)}.\n`,
      "stderr",
    );
    return;
  }

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runtimeInfo = yield* RuntimeInfo;
  const networkIdFlag = yield* NetworkIdFlag;
  // PG15 fresh-volume migrate jobs tee stderr when `--debug` is set.
  const debug = yield* DebugFlag;

  // Error if the local db container is down.
  const running = yield* isLocalDbRunning(
    spawner,
    fs,
    path,
    workdir,
    Option.getOrUndefined(cliSettings.projectId),
  );
  if (!running) {
    return yield* Effect.fail(notRunning());
  }
  // "Resetting local database…" then recreate + migrate + seed.
  yield* output.raw(`Resetting local database${toLogMessage(input.version)}\n`, "stderr");

  // Build the same prelude `db start`'s own handler builds (config values +
  // `resolveDbBootstrapConfig`), so the container is recreated with identical inputs.
  const inputs = yield* buildLocalDbContainerInputs(
    spawner,
    workdir,
    networkIdFlag,
    runtimeInfo.platform,
    debug,
  );
  const {
    context: { projectId, hostname, config, loaded },
    values,
    bootstrapConfig,
    networkId,
    containerOpts,
    dbContainerId,
    postgresSpecBase,
    resolvePostgresImage,
    setup,
  } = inputs;

  yield* recreateLocalDatabase(spawner, {
    fs,
    path,
    workdir,
    projectId,
    networkId,
    hostname,
    dbContainerId,
    dbPort: values.dbPort,
    containerOpts,
    // `db reset` has no `fromBackup` concept, so `postgresSpecBase` is already the whole
    // `postgresSpec` here.
    postgresSpec: postgresSpecBase,
    resolvePostgresImage,
    dbHealthTimeoutSeconds: bootstrapConfig.dbHealthTimeoutSeconds,
    version: input.version,
    seedFlags: input.seedFlags,
    // `db reset` resolves `--experimental` earlier than this prelude does, via the nested-env
    // walk above; override the prelude's own `setup.experimental` with that value so the two
    // stay consistent.
    setup: { ...setup, experimental },
  });

  // Seed objects from supabase/buckets when storage is up; summary is suppressed since reset
  // emits its own result.
  const storageReady = yield* awaitStorageReady(spawner, projectId);
  if (storageReady) {
    // Non-interactive: overwrite/prune confirmations never open a TTY prompt. In text mode
    // each still prints its label and scans one stdin line (bounded) — a parsed y/n answer
    // wins, otherwise its default applies (overwrite → yes, prune → no); machine formats take
    // the defaults silently. `resolvedConfig` reuses the config already resolved via
    // `buildLocalDbContainerInputs`'s full nested-env walk, so `seedBucketsRun` never
    // independently reloads config.toml through a narrower env resolution that could reject a
    // config whose `env(VAR)` reference is backed by a non-default dotenv file. Unlike
    // `start`, this path does not pass `promptless`, so the bounded stdin scan still happens
    // here.
    yield* seedBucketsRun({
      projectRef: "",
      emitSummary: false,
      interactive: false,
      // `SUPABASE_YES` set in `supabase/.env` auto-confirms the bucket overwrite/prune
      // prompts.
      yes,
      resolvedConfig: { config, document: loaded?.document },
      // The same nested-dotenv walk already resolved for `yes`/`experimental` above.
      projectEnvValues: projectEnv,
    }).pipe(
      // An invalid bucket entry (bad name, unparseable `file_size_limit`, …) can't abort here —
      // recreate already dropped/rebuilt the DB — so warn and skip buckets instead.
      Effect.catchTag("SeedConfigLoadError", (error) =>
        output.raw(
          `${yellow("WARNING:")} skipped seeding storage buckets: ${error.message}\n`,
          "stderr",
        ),
      ),
    );
  }

  const branch = Option.getOrElse(yield* detectGitBranch(workdir), () => "main");
  yield* output.raw(`Finished ${aqua("supabase db reset")} on branch ${aqua(branch)}.\n`, "stderr");
});
