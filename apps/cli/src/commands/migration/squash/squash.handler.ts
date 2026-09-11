import { Effect, FileSystem, Option, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcessSpawner as ChildProcessSpawnerType } from "effect/unstable/process/ChildProcessSpawner";

import { cobraMutuallyExclusiveErrorMessage } from "../../../shared/cli/cobra-flag-groups.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  NetworkIdFlag,
  resolveYesWithProjectEnv,
} from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { aqua, bold } from "../../../command-internal/colors.ts";
import {
  buildLocalDbContainerInputs,
  type LocalDbContainerInputs,
} from "../../../command-internal/db-bootstrap/local-container-inputs.ts";
import {
  resolveDbSetupPrelude,
  setupDatabase,
} from "../../../command-internal/db-bootstrap/db-setup.ts";
import { waitForHealthyServices } from "../../../command-internal/db-bootstrap/health-check.ts";
import {
  buildShadowSetupDatabaseInput,
  connectShadowDatabase,
  createShadowDatabase,
  removeShadowDatabase,
  shadowRunInputFromLocalContainerInputs,
} from "../../../command-internal/db-bootstrap/shadow-database.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import {
  applyProjectEnv,
  loadProjectEnv,
  readDbToml,
  type DbTomlValues,
} from "../../../command-internal/db-config.toml-read.ts";
import type { ResolvedDbConfig } from "../../../command-internal/db-config.types.ts";
import { DbConnection, type PgConnInput } from "../../../command-internal/db-connection.service.ts";
import { resolveDbTargetFlags } from "../../../command-internal/db-target-flags.ts";
import { DebugLogger } from "../../../command-internal/debug-logger.service.ts";
import { errorMessage, relativizeErrorMessage } from "../../../command-internal/error-message.ts";
import { currentStackBackend } from "../../../command-internal/stack-backend.ts";
import { stackWithShadowDatabase } from "../../../command-internal/stack-shadow.ts";
import {
  dumpConnForHostClient,
  rewriteDumpHostForToolContainer,
} from "../../../command-internal/postgres-client.run.ts";
import { applyMigrations, MigrationApplyError } from "../../../command-internal/migration-apply.ts";
import {
  INSERT_MIGRATION_VERSION,
  DELETE_MIGRATION_BEFORE,
  createMigrationTable,
  loadLocalVersions,
  loadPartialMigrations,
  readMigrationFile,
  resolveMigrationFile,
} from "../../../command-internal/migration-history.ts";
import { parseMigrationVersion } from "../../../command-internal/migration-timestamp.format.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import {
  MigrationFileNotFoundError,
  MigrationInvalidVersionError,
  MigrationPasswordFlagsError,
  MigrationTargetFlagsError,
} from "../migration.errors.ts";
import { migrationConfirm } from "../migration.prompt.ts";
import type { MigrationSquashFlags } from "./squash.command.ts";
import { SQUASH_SEPARATOR_COMMENT, squashLineByLineDiff } from "./squash.diff.ts";
import { squashDumpSchema, squashDumpSchemaToString } from "./squash.dump.ts";
import {
  MigrationSquashBaselineError,
  MigrationSquashMissingVersionError,
  MigrationSquashWriteError,
} from "./squash.errors.ts";

type Spawner = ChildProcessSpawnerType["Service"];

/**
 * Creates the shadow database, then runs health-wait/connect/setup/dump/apply/dump in
 * the interruptible `use` phase. `acquire` is only the brief, Docker-API-bound shadow
 * creation, so a SIGINT during the health-wait lands immediately from a single
 * cancellable scope.
 */
const squashMigrations = Effect.fnUntraced(function* (
  spawner: Spawner,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  migrations: ReadonlyArray<string>,
  localInputs: LocalDbContainerInputs,
  toml: DbTomlValues,
) {
  const stackBackend = (yield* currentStackBackend).kind === "stack";
  const resolvedShadowImage = stackBackend
    ? "stack-ephemeral"
    : yield* localInputs.resolvePostgresImage;
  const shadowInput = shadowRunInputFromLocalContainerInputs(
    localInputs,
    resolvedShadowImage,
    toml,
    fs,
    path,
  );
  const connConfig: PgConnInput = {
    host: localInputs.context.hostname,
    port: toml.shadowPort,
    user: "postgres",
    password: toml.password,
    database: "postgres",
  };
  // The pin-resolved (not yet registry-mapped) image every
  // `pg_dump` container below uses; `squashDumpSchema` applies the registry mirror itself.
  const image = localInputs.bootstrapConfig.postgresImage;

  if (stackBackend) {
    return yield* stackWithShadowDatabase(shadowInput, (handle) =>
      Effect.scoped(
        Effect.gen(function* () {
          const stackConn: PgConnInput = {
            host: handle.host,
            port: handle.port,
            user: "postgres",
            password: toml.password,
            database: "postgres",
          };
          const runtimeInfo = yield* RuntimeInfo;
          const networkIdFlag = yield* NetworkIdFlag;
          const networkId = Option.getOrUndefined(networkIdFlag);
          const dumpUsesHostNetwork = networkId === undefined || networkId.length === 0;
          const nativeShadow = handle.runtime.kind === "native";
          const dumpClient = nativeShadow
            ? {
                kind: "host" as const,
                command: "pg_dump" as const,
                expectedMajor: toml.majorVersion,
              }
            : { kind: "container" as const };
          const dumpConn: PgConnInput = nativeShadow
            ? dumpConnForHostClient(stackConn)
            : {
                ...stackConn,
                host: rewriteDumpHostForToolContainer(handle.host, {
                  platform: runtimeInfo.platform,
                  usesHostNetwork: dumpUsesHostNetwork,
                }),
              };
          const session = yield* connectShadowDatabase(stackConn);
          const before = yield* squashDumpSchemaToString({
            image,
            conn: dumpConn,
            schema: ["auth", "storage"],
            projectEnvValues: localInputs.context.projectEnvValues,
            client: dumpClient,
          });
          yield* applyMigrations(
            session,
            fs,
            path,
            migrations,
            (message) => new MigrationApplyError({ message }),
          );
          const after = yield* squashDumpSchemaToString({
            image,
            conn: dumpConn,
            schema: ["auth", "storage"],
            projectEnvValues: localInputs.context.projectEnvValues,
            client: dumpClient,
          });
          const targetPath = migrations[migrations.length - 1]!;
          const targetRel = path.relative(workdir, targetPath);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const file = yield* fs.open(targetPath, { flag: "w", mode: 0o644 }).pipe(
                Effect.mapError(
                  (cause) =>
                    new MigrationSquashWriteError({
                      message: `failed to open migration file: ${relativizeErrorMessage(errorMessage(cause), targetPath, targetRel)}`,
                    }),
                ),
              );
              yield* squashDumpSchema({
                image,
                conn: dumpConn,
                schema: [],
                projectEnvValues: localInputs.context.projectEnvValues,
                client: dumpClient,
                onStdout: (chunk) =>
                  file.writeAll(chunk).pipe(
                    Effect.mapError(
                      (cause) =>
                        new MigrationSquashWriteError({
                          message: `failed to copy docker logs: ${errorMessage(cause)}`,
                        }),
                    ),
                  ),
              });
              const tail = SQUASH_SEPARATOR_COMMENT + squashLineByLineDiff(before, after);
              yield* file.writeAll(new TextEncoder().encode(tail)).pipe(
                Effect.mapError(
                  (cause) =>
                    new MigrationSquashWriteError({
                      message: `failed to write line: ${relativizeErrorMessage(errorMessage(cause), targetPath, targetRel)}`,
                    }),
                ),
              );
            }),
          );
        }),
      ),
    );
  }

  yield* Effect.acquireUseRelease(
    createShadowDatabase(spawner, shadowInput),
    (handle) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* waitForHealthyServices(spawner, [handle.containerId], {
            timeoutSeconds: shadowInput.healthTimeoutSeconds,
          });
          const session = yield* connectShadowDatabase(connConfig);
          const resolved = yield* resolveDbSetupPrelude(shadowInput.setup);
          yield* setupDatabase(
            spawner,
            buildShadowSetupDatabaseInput(
              {
                fs: shadowInput.fs,
                path: shadowInput.path,
                workdir: shadowInput.workdir,
                projectId: shadowInput.projectId,
                container: handle.containerId,
                networkId: shadowInput.networkId,
                connConfig,
                setup: shadowInput.setup,
              },
              session,
              resolved,
            ),
          );

          const before = yield* squashDumpSchemaToString({
            image,
            conn: connConfig,
            schema: ["auth", "storage"],
            projectEnvValues: localInputs.context.projectEnvValues,
          });
          yield* applyMigrations(
            session,
            fs,
            path,
            migrations,
            (message) => new MigrationApplyError({ message }),
          );
          const after = yield* squashDumpSchemaToString({
            image,
            conn: connConfig,
            schema: ["auth", "storage"],
            projectEnvValues: localInputs.context.projectEnvValues,
          });

          const targetPath = migrations[migrations.length - 1]!;
          const targetRel = path.relative(workdir, targetPath);
          yield* Effect.scoped(
            Effect.gen(function* () {
              // One open call truncates (or creates) the target file and opens it for the
              // writes below; there is no separate truncate-then-reopen step.
              const file = yield* fs.open(targetPath, { flag: "w", mode: 0o644 }).pipe(
                Effect.mapError(
                  (cause) =>
                    new MigrationSquashWriteError({
                      message: `failed to open migration file: ${relativizeErrorMessage(errorMessage(cause), targetPath, targetRel)}`,
                    }),
                ),
              );
              // The full, unrestricted dump streams into the already-truncated file at
              // constant memory; a failure here is the docker-log-stream write, so it
              // reports "failed to copy docker logs:" rather than "failed to write line:".
              yield* squashDumpSchema({
                image,
                conn: connConfig,
                schema: [],
                projectEnvValues: localInputs.context.projectEnvValues,
                onStdout: (chunk) =>
                  file.writeAll(chunk).pipe(
                    Effect.mapError(
                      (cause) =>
                        new MigrationSquashWriteError({
                          message: `failed to copy docker logs: ${errorMessage(cause)}`,
                        }),
                    ),
                  ),
              });
              // Combined into a single writeAll so the separator and diff write atomically
              // to the same handle.
              const tail = SQUASH_SEPARATOR_COMMENT + squashLineByLineDiff(before, after);
              yield* file.writeAll(new TextEncoder().encode(tail)).pipe(
                Effect.mapError(
                  (cause) =>
                    new MigrationSquashWriteError({
                      message: `failed to write line: ${relativizeErrorMessage(errorMessage(cause), targetPath, targetRel)}`,
                    }),
                ),
              );
            }),
          );
        }),
      ),
    (handle) => removeShadowDatabase(spawner, handle.containerId),
  );
});

/** Outcome of {@link squashToVersion} — feeds the machine-mode payload. */
interface SquashToVersionResult {
  readonly alreadyEarliest: boolean;
  /** Workdir-relative path of the migration everything squashed into. */
  readonly target: string;
  /** Workdir-relative paths of the merged files that were successfully removed. */
  readonly removed: ReadonlyArray<string>;
  /** The rest: merged files whose removal failed — non-fatal, so `removed`/`removeFailures` always partition every merged file between them. */
  readonly removeFailures: ReadonlyArray<{ readonly path: string; readonly message: string }>;
}

/**
 * Loads the local migrations up to `version` (all when empty), squashes every one but
 * the last into the shadow-produced dump, then removes the merged files. A removal
 * failure is non-fatal: only printed to stderr, then continues.
 */
const squashToVersion = Effect.fnUntraced(function* (
  spawner: Spawner,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  migrationsDir: string,
  version: string,
  localInputs: LocalDbContainerInputs,
  toml: DbTomlValues,
) {
  const output = yield* Output;
  const migrations = yield* loadPartialMigrations(fs, path, migrationsDir, version);
  if (migrations.length === 0) {
    return yield* Effect.fail(
      new MigrationSquashMissingVersionError({ message: "version not found" }),
    );
  }

  const local = migrations[migrations.length - 1]!;
  const rel = path.relative(workdir, local);
  if (migrations.length === 1) {
    yield* output.raw(`${bold(rel)} is already the earliest migration.\n`, "stderr");
    return {
      alreadyEarliest: true,
      target: rel,
      removed: [],
      removeFailures: [],
    } satisfies SquashToVersionResult;
  }

  yield* squashMigrations(spawner, fs, path, workdir, migrations, localInputs, toml);
  yield* output.raw(`Squashed local migrations to ${bold(rel)}\n`, "stderr");

  const removed: Array<string> = [];
  const removeFailures: Array<{ readonly path: string; readonly message: string }> = [];
  for (const merged of migrations.slice(0, -1)) {
    const mergedRel = path.relative(workdir, merged);
    yield* fs.remove(merged).pipe(
      Effect.matchEffect({
        onFailure: (cause) => {
          const message = relativizeErrorMessage(errorMessage(cause), merged, mergedRel);
          removeFailures.push({ path: mergedRel, message });
          return output.raw(`${message}\n`, "stderr");
        },
        onSuccess: () =>
          Effect.sync(() => {
            removed.push(mergedRel);
          }),
      }),
    );
  }
  return {
    alreadyEarliest: false,
    target: rel,
    removed,
    removeFailures,
  } satisfies SquashToVersionResult;
});

/**
 * Re-derives an empty `version` from the local version listing after
 * `squashToVersion`'s removals complete (not the already-known target version), so a
 * non-fatal removal failure baselines to the surviving older version instead. Prints
 * the "Baselining…" banner before connecting, then deletes every history row `<=
 * version` and inserts the target migration's row in one transaction.
 */
const baselineMigrations = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationsDir: string,
  cfg: ResolvedDbConfig,
  dnsResolver: "native" | "https",
  version: string,
) {
  const output = yield* Output;
  const connection = yield* DbConnection;
  const debugLogger = yield* DebugLogger;

  let resolvedVersion = version;
  if (resolvedVersion.length === 0) {
    // A read failure only logs via the debug logger and leaves version empty; it
    // never aborts the baseline.
    const local = yield* loadLocalVersions(fs, path, migrationsDir).pipe(
      Effect.catch((cause) =>
        debugLogger.debug(cause.message).pipe(Effect.as<ReadonlyArray<string>>([])),
      ),
    );
    if (local.length > 0) resolvedVersion = local[0]!;
  }

  // Printed before connecting, the opposite order from every other prompting migration
  // subcommand.
  yield* output.raw(`Baselining migration history to ${resolvedVersion}\n`, "stderr");

  yield* Effect.scoped(
    Effect.gen(function* () {
      // Always remote: runSquash already returns early on a local target, so
      // cfg.isLocal is always false when this function runs.
      yield* output.raw("Connecting to remote database...\n", "stderr");
      const session = yield* connection.connect(cfg.conn, { isLocal: cfg.isLocal, dnsResolver });
      yield* createMigrationTable(session);

      const resolvedFile = yield* resolveMigrationFile(fs, path, migrationsDir, resolvedVersion);
      if (Option.isNone(resolvedFile)) {
        return yield* Effect.fail(
          new MigrationFileNotFoundError({
            message: `glob supabase/migrations/${resolvedVersion}_*.sql: file does not exist`,
          }),
        );
      }
      const m = yield* readMigrationFile(fs, path, resolvedFile.value);

      // Wrapped in an explicit transaction for atomicity between the DELETE and the
      // INSERT, like migration repair's updateMigrationTable.
      const txn = Effect.gen(function* () {
        yield* session.exec("BEGIN");
        yield* session.query(DELETE_MIGRATION_BEFORE, [m.version]);
        yield* session.query(INSERT_MIGRATION_VERSION, [m.version, m.name, m.statements]);
        yield* session.exec("COMMIT");
      });
      yield* txn.pipe(
        Effect.tapError(() => session.exec("ROLLBACK").pipe(Effect.ignore)),
        Effect.mapError(
          (cause) =>
            new MigrationSquashBaselineError({
              message: `failed to update migration history: ${errorMessage(cause)}`,
            }),
        ),
      );
    }),
  );

  return resolvedVersion;
});

const runSquash = Effect.fnUntraced(function* (
  flags: MigrationSquashFlags,
  target: ReturnType<typeof resolveDbTargetFlags>,
) {
  const output = yield* Output;
  const resolver = yield* DbConfigResolver;
  const cliSettings = yield* CommandSettings;
  const linkedProjectCache = yield* LinkedProjectCache;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* DnsResolverFlag;
  const debug = yield* DebugFlag;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runtimeInfo = yield* RuntimeInfo;
  const networkIdFlag = yield* NetworkIdFlag;

  // Resolved linked ref, captured so the post-run finalizer caches the project
  // (GET /v1/projects/{ref}).
  let linkedRefForCache: string | undefined;

  yield* Effect.gen(function* () {
    // Checked here, ahead of the root pre-run.
    if (target.setFlags.length > 1) {
      return yield* Effect.fail(
        new MigrationTargetFlagsError({
          message: cobraMutuallyExclusiveErrorMessage(
            ["db-url", "linked", "local"],
            target.setFlags,
          ),
        }),
      );
    }
    if (Option.isSome(flags.dbUrl) && Option.isSome(flags.password)) {
      return yield* Effect.fail(
        new MigrationPasswordFlagsError({
          message: cobraMutuallyExclusiveErrorMessage(
            ["db-url", "password"],
            ["db-url", "password"],
          ),
        }),
      );
    }

    const migrationsDir = path.join(cliSettings.workdir, "supabase", "migrations");
    const connType = target.connType ?? "local";

    // `--project-ref` never implies `--linked` and must not be silently
    // discarded on a non-linked target; see push.handler.ts's identical guard.
    if (Option.isSome(flags.projectRef) && connType !== "linked") {
      return yield* Effect.fail(
        new MigrationTargetFlagsError({
          message:
            "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
        }),
      );
    }

    // Resolves and caches the project ref, then reads the remote-merged config before
    // resolver.resolve() below (like db diff --linked); read unconditionally since the
    // shadow is provisioned locally either way.
    let linkedRef: string | undefined;
    if (connType === "linked") {
      const projectRefResolver = yield* ProjectRefResolver;
      linkedRef = yield* projectRefResolver.loadProjectRef(flags.projectRef);
      linkedRefForCache = linkedRef;
    }
    const toml = yield* readDbToml(fs, path, cliSettings.workdir, linkedRef);
    if (toml.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${toml.appliedRemote}]\n`, "stderr");
    }

    // The shadow's container spec is always built before resolver.resolve() below, so
    // all config load/validation happens ahead of the actual connection resolution.
    const localInputs = yield* buildLocalDbContainerInputs(
      spawner,
      cliSettings.workdir,
      networkIdFlag,
      runtimeInfo.platform,
      debug,
      connType === "linked" ? linkedRef : undefined,
      toml.remoteOverrideKeys,
    );

    // The resolver owns --password/DB_PASSWORD/temp-login-role/IPv6 handling for
    // --linked, so squash needs no bespoke password prompt.
    const cfg = yield* resolver.resolve({
      dbUrl: flags.dbUrl,
      connType,
      dnsResolver,
      password: flags.password,
      linkedProjectRef: flags.projectRef,
    });
    if (linkedRef === undefined) {
      linkedRef = Option.getOrUndefined(cfg.ref ?? Option.none());
    }
    if (linkedRef !== undefined) linkedRefForCache = linkedRef;

    // Loads after the flag-group check above, so a flag conflict surfaces before any
    // .env read; a SUPABASE_YES set only in supabase/.env still auto-confirms the
    // remote-baseline prompt.
    const projectEnv = yield* loadProjectEnv(fs, path, cliSettings.workdir);
    // Makes an allowlisted supabase/.env registry override visible to the synchronous
    // process.env reader in getRegistryImageUrl, reverted when the scope closes, so all
    // three pg_dump containers below see the same registry-mirror override.
    yield* applyProjectEnv(projectEnv);
    const yes = yield* resolveYesWithProjectEnv(projectEnv);

    // Runs after DB-config resolution, so an invalid target surfaces first.
    const version = Option.getOrElse(flags.version, () => "");
    if (version.length > 0) {
      if (parseMigrationVersion(version) === undefined) {
        // Bare message; squash does not inherit repair's "failed to parse <v>:" prefix.
        return yield* Effect.fail(
          new MigrationInvalidVersionError({ message: "invalid version number" }),
        );
      }
      const versionFile = yield* resolveMigrationFile(fs, path, migrationsDir, version);
      if (Option.isNone(versionFile)) {
        return yield* Effect.fail(
          new MigrationFileNotFoundError({
            message: `glob supabase/migrations/${version}_*.sql: file does not exist`,
          }),
        );
      }
    }

    const squashResult = yield* squashToVersion(
      spawner,
      fs,
      path,
      cliSettings.workdir,
      migrationsDir,
      version,
      localInputs,
      toml,
    );

    // Local target: suggest migration repair instead of touching the remote history.
    if (cfg.isLocal) {
      if (output.format === "text") {
        yield* output.raw(`Finished ${aqua("supabase migration squash")}.\n`);
        yield* output.raw(
          `Run ${aqua("supabase migration repair --status applied")} to update your remote migration history table.\n`,
          "stderr",
        );
      } else {
        yield* output.success("Migrations squashed", {
          squashedInto: squashResult.target,
          removed: squashResult.removed,
          removeFailures: squashResult.removeFailures,
          alreadyEarliest: squashResult.alreadyEarliest,
          isLocal: true,
          baselinedVersion: null,
        });
      }
      return;
    }

    // A declined prompt is still a success path here (returns cleanly, not a
    // cancellation), unlike repair/fetch/down.
    const confirmed = yield* migrationConfirm("Update remote migration history table?", {
      defaultValue: true,
      yes,
    });
    let baselinedVersion: string | null = null;
    if (confirmed) {
      baselinedVersion = yield* baselineMigrations(
        fs,
        path,
        migrationsDir,
        cfg,
        dnsResolver,
        version,
      );
    }

    if (output.format === "text") {
      yield* output.raw(`Finished ${aqua("supabase migration squash")}.\n`);
    } else {
      yield* output.success("Migrations squashed", {
        squashedInto: squashResult.target,
        removed: squashResult.removed,
        removeFailures: squashResult.removeFailures,
        alreadyEarliest: squashResult.alreadyEarliest,
        isLocal: false,
        baselinedVersion,
      });
    }
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        linkedRefForCache !== undefined ? linkedProjectCache.cache(linkedRefForCache) : Effect.void,
      ),
    ),
    // Scope the `SUPABASE_INTERNAL_IMAGE_REGISTRY`-from-`.env` apply above to this
    // command run: `applyProjectEnv` registers a finalizer that reverts it.
    Effect.scoped,
  );
});

export const migrationSquash = Effect.fn("migration.squash")(function* (
  flags: MigrationSquashFlags,
) {
  const telemetryState = yield* TelemetryState;
  const cliArgs = yield* CliArgs;
  const target = resolveDbTargetFlags(cliArgs.args);
  yield* runSquash(flags, target).pipe(Effect.ensuring(telemetryState.flush));
});
