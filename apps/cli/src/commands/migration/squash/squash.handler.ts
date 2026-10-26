import { Effect, FileSystem, Option, Path } from "effect";
import { ChildProcessSpawner } from "effect/process";
import type { ChildProcessSpawner as ChildProcessSpawnerType } from "effect/process/ChildProcessSpawner";

import {
  DebugFlag,
  DnsResolverFlag,
  NetworkIdFlag,
} from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
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
import { readDbToml, type DbTomlValues } from "../../../command-internal/db-config.toml-read.ts";
import type { ResolvedDbConfig } from "../../../command-internal/db-config.types.ts";
import { DbConnection, type PgConnInput } from "../../../command-internal/db-connection.service.ts";
import {
  hostedMutationPreapproval,
  requireTargetMutationConsent,
} from "../../../command-internal/hosted-consent/hosted-consent.ts";
import { DebugLogger } from "../../../shared/output/debug-logger.service.ts";
import { errorMessage, relativizeErrorMessage } from "../../../command-internal/error-message.ts";
import { currentStackBackend } from "../../../command-internal/stack-backend.ts";
import { stackWithShadowDatabase } from "../../../command-internal/stack-shadow.ts";
import { parseConnectionString } from "../../../command-internal/db-config.parse.ts";

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
import { resolveTarget } from "../../../command-internal/target/resolve-target.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { MigrationFileNotFoundError, MigrationInvalidVersionError } from "../migration.errors.ts";
import type { MigrationSquashFlags } from "./squash.command.ts";
import { SQUASH_SEPARATOR_COMMENT, squashLineByLineDiff } from "./squash.diff.ts";
import { squashDumpSchema, squashDumpSchemaToString } from "./squash.dump.ts";
import {
  MigrationSquashBaselineError,
  MigrationSquashDumpError,
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
const squashMigrations = Effect.fn("MigrationSquash.squashMigrations")(function* (
  spawner: Spawner,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  migrations: ReadonlyArray<string>,
  targetPath: string,
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
          const credentials = yield* handle.database.credentials({ from: "runtime" });
          const dumpConn = yield* parseConnectionString(credentials.databaseUrl ?? "");
          if (dumpConn === undefined)
            return yield* new MigrationSquashDumpError({
              message: "Shadow database tool URL is unavailable",
            });
          const dumpClient = {
            kind: "stack" as const,
            stack: handle.stack,
            command: "pg_dump" as const,
            pin: handle.databasePin,
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
 * Squashes every migration but the last into the shadow-produced dump, then removes the merged
 * files. A removal failure is non-fatal: only printed to stderr, then continues.
 */
const squashToVersion = Effect.fn("MigrationSquash.squashToVersion")(function* (
  spawner: Spawner,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  migrations: ReadonlyArray<string>,
  local: string,
  localInputs: LocalDbContainerInputs,
  toml: DbTomlValues,
) {
  const output = yield* Output;
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

  yield* squashMigrations(spawner, fs, path, workdir, migrations, local, localInputs, toml);
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
const baselineMigrations = Effect.fn("MigrationSquash.baselineMigrations")(function* (
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
    resolvedVersion = local[0] ?? resolvedVersion;
  }

  // Printed before connecting, the opposite order from every other prompting migration
  // subcommand.
  yield* output.raw(`Baselining migration history to ${resolvedVersion}\n`, "stderr");

  yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* connection.connect(cfg.conn, { isLocal: cfg.isLocal, dnsResolver });
      yield* createMigrationTable(session);

      const resolvedFile = yield* resolveMigrationFile(fs, path, migrationsDir, resolvedVersion);
      if (Option.isNone(resolvedFile)) {
        return yield* new MigrationFileNotFoundError({
          message: `glob supabase/migrations/${resolvedVersion}_*.sql: file does not exist`,
        });
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

const runSquash = Effect.fnUntraced(function* (flags: MigrationSquashFlags) {
  const output = yield* Output;
  const resolver = yield* DbConfigResolver;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* DnsResolverFlag;
  const debug = yield* DebugFlag;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runtimeInfo = yield* RuntimeInfo;
  const networkIdFlag = yield* NetworkIdFlag;

  const target = yield* resolveTarget(flags);
  const linkedRef = target.kind === "linked" ? target.ref : undefined;

  const squashFlow = Effect.gen(function* () {
    const migrationsDir = path.join(cliSettings.workdir, "supabase", "migrations");

    // Reads the remote-merged config before resolving the connection (like `db diff --remote`);
    // read unconditionally since the shadow is provisioned locally either way.
    const toml = yield* readDbToml(fs, path, cliSettings.workdir, linkedRef);
    if (toml.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${toml.appliedRemote}]\n`, "stderr");
    }

    // The shadow's container spec is always built before the connection resolves, so
    // all config load/validation happens ahead of the actual connection resolution.
    const localInputs = yield* buildLocalDbContainerInputs(
      spawner,
      cliSettings.workdir,
      networkIdFlag,
      runtimeInfo.platform,
      debug,
      linkedRef,
    );

    // The resolver owns --password/DB_PASSWORD/temp-login-role/IPv6 handling for a
    // remote target, so squash needs no bespoke password prompt.
    const cfg = yield* resolver.resolveConnection({
      target,
      dnsResolver,
      password: flags.password,
      hasPasswordFlag: true,
      networkBanRemoval: yield* hostedMutationPreapproval,
    });
    yield* Effect.annotateCurrentSpan({ "db.conn_type": target.kind, "db.is_local": cfg.isLocal });

    // Runs after connection resolution, so an invalid target surfaces first.
    const version = Option.getOrElse(flags.version, () => "");
    if (version.length > 0) {
      if (parseMigrationVersion(version) === undefined) {
        // Bare message; squash does not inherit repair's "failed to parse <v>:" prefix.
        return yield* new MigrationInvalidVersionError({ message: "invalid version number" });
      }
      const versionFile = yield* resolveMigrationFile(fs, path, migrationsDir, version);
      if (Option.isNone(versionFile)) {
        return yield* new MigrationFileNotFoundError({
          message: `glob supabase/migrations/${version}_*.sql: file does not exist`,
        });
      }
    }

    const migrations = yield* loadPartialMigrations(fs, path, migrationsDir, version);
    yield* Effect.annotateCurrentSpan({ "migration.count": migrations.length });
    const squashInto = migrations.at(-1);
    if (squashInto === undefined) {
      return yield* new MigrationSquashMissingVersionError({ message: "version not found" });
    }

    // The checkout rewrite precedes the remote history update, so both sit behind one consent.
    yield* requireTargetMutationConsent(cfg, {
      action: "Squash local migrations and update the remote migration history table",
      details: [
        migrations.length > 1
          ? `Squash ${migrations.length} local migrations into ${path.relative(cliSettings.workdir, squashInto)} and remove the ${migrations.length - 1} merged ${migrations.length === 2 ? "file" : "files"}`
          : `${path.relative(cliSettings.workdir, squashInto)} is already the earliest migration`,
        "Reset the remote migration history table to the squashed migration",
      ],
    });

    const squashResult = yield* squashToVersion(
      spawner,
      fs,
      path,
      cliSettings.workdir,
      migrations,
      squashInto,
      localInputs,
      toml,
    );

    // Local target: suggest migration repair instead of touching the remote history.
    if (cfg.isLocal) {
      if (output.format === "text") {
        yield* output.raw(`Finished ${aqua("supabase migration squash")}.\n`);
        yield* output.raw(
          `Run ${aqua("supabase migration repair --status applied --remote")} to update your remote migration history table.\n`,
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

    const baselinedVersion = yield* baselineMigrations(
      fs,
      path,
      migrationsDir,
      cfg,
      dnsResolver,
      version,
    );

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
  });

  if (target.kind === "linked") {
    const linkedProjectCache = yield* LinkedProjectCache;
    return yield* squashFlow.pipe(Effect.ensuring(linkedProjectCache.cache(target.ref)));
  }
  return yield* squashFlow;
});

export const migrationSquash = Effect.fn("migration.squash")(function* (
  flags: MigrationSquashFlags,
) {
  const telemetryState = yield* TelemetryState;
  yield* runSquash(flags).pipe(Effect.ensuring(telemetryState.flush));
});
