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
 * `squashMigrations`:
 * shadow create -> health-wait -> connect -> `start.SetupDatabase` DIRECTLY
 * (NOT `setupShadowConn`, so NO `CREATE DATABASE contrib_regression` template) -> dump the
 * auth/storage schema before migrating -> apply every migration -> dump auth/storage again ->
 * write the target file as the FULL (unrestricted) dump + the separator + the auth/storage
 * line diff. `acquire` is only shadow creation (brief, Docker-API-bound); the health-wait/
 * connect/setup/dump/apply sequence runs in the interruptible `use` phase, matching the CLI-1956
 * review ruling `shadow-database.ts`/`diff.handler.ts` already established (a SIGINT during the
 * health-wait must land immediately, from a single cancellable scope).
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
  const resolvedShadowImage = yield* localInputs.resolvePostgresImage;
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
              // One open call that both truncates (or creates) the target file AND opens it for the
              // writes below, matching `new.handler.ts:87`'s identical `{ flag: "w" }` precedent.
              // There is no separate truncate-then-reopen step.
              const file = yield* fs.open(targetPath, { flag: "w", mode: 0o644 }).pipe(
                Effect.mapError(
                  (cause) =>
                    new MigrationSquashWriteError({
                      message: `failed to open migration file: ${relativizeErrorMessage(errorMessage(cause), targetPath, targetRel)}`,
                    }),
                ),
              );
              // The full dump — NO schema restriction — streamed straight into the
              // already-truncated file at constant memory. The underlying failure here is
              // the docker-log-stream write into the file handle,
              // not the line-diff writer below, so it byte-matches "failed to copy
              // docker logs:" rather than "failed to write line:".
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
              // The separator and the auth/storage line diff write sequentially to the
              // SAME handle, with nothing observable
              // between the two writes — combined into one `writeAll` here.
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
 * `squashToVersion`: loads the local migrations up to `version` (all when empty), squashes
 * every one but the last into the shadow-produced dump, then removes the merged files — a
 * removal failure is NON-FATAL (only printed to stderr, then continues).
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
 * `baselineMigrations`: re-derives an empty `version` from the (POST-file-removal) local
 * version listing, prints the "Baselining…" banner BEFORE connecting, then deletes every
 * history row `<= version` and inserts the target migration's row in one transaction.
 *
 * The re-list runs AFTER `squashToVersion`'s file removals (this function is only ever called
 * once that has fully completed) — so when a merged-file removal failed non-fatally, this
 * baselines to the surviving OLDER version, not the squash target. Do not "optimise" this by
 * passing the already-known target version through instead; that would silently diverge from
 * the established behavior on exactly that path.
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
    // A read failure only logs via the debug logger
    // and leaves `version` empty; it never aborts the baseline.
    const local = yield* loadLocalVersions(fs, path, migrationsDir).pipe(
      Effect.catch((cause) =>
        debugLogger.debug(cause.message).pipe(Effect.as<ReadonlyArray<string>>([])),
      ),
    );
    if (local.length > 0) resolvedVersion = local[0]!;
  }

  // Printed BEFORE connecting — the opposite order from every other prompting migration
  // subcommand.
  yield* output.raw(`Baselining migration history to ${resolvedVersion}\n`, "stderr");

  yield* Effect.scoped(
    Effect.gen(function* () {
      // Always remote: `runSquash` already returned on the local target (step 9) before
      // `baselineMigrations` is ever called, so `cfg.isLocal` is necessarily `false` here —
      // the unconditional "Connecting to remote database..." on this path is the only
      // reachable branch from `baselineMigrations`'s only caller.
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

      // Data statements only, no schema mutation, so
      // (matching `migration repair`'s own `updateMigrationTable`) wrapped in an explicit
      // transaction for atomicity between the DELETE and the INSERT.
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
    // 1. Flag groups — parse-time mutual-exclusivity check, ahead of the root
    // pre-run.
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
    // squash defaults to `--local`, same as `up`/`down`.
    const connType = target.connType ?? "local";

    // `--project-ref` never implies `--linked` and must not be silently
    // discarded on a non-linked target — see push.handler.ts's identical guard
    // (db push) for the full TS-only rationale.
    if (Option.isSome(flags.projectRef) && connType !== "linked") {
      return yield* Effect.fail(
        new MigrationTargetFlagsError({
          message:
            "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
        }),
      );
    }

    // 2/3. Linked pre-resolution (mirrors `db diff --linked`, `diff.handler.ts:400-430`):
    // resolve + cache the project ref, and read the remote-merged config, BEFORE
    // `resolver.resolve()` below. Read unconditionally (base config when not linked) since the
    // shadow is provisioned locally regardless of the remote/local target.
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

    // 4. The shadow's own container spec — always built, and built BEFORE `resolver.resolve()`
    // below, matching `diff.handler.ts`'s identical
    // rationale: all config load/validation happens ahead of the actual connection resolution.
    const localInputs = yield* buildLocalDbContainerInputs(
      spawner,
      cliSettings.workdir,
      networkIdFlag,
      runtimeInfo.platform,
      debug,
      connType === "linked" ? linkedRef : undefined,
      toml.remoteOverrideKeys,
    );

    // 5. Resolve the target connection — the resolver owns `--password`/`DB_PASSWORD`/
    // temp-login-role/IPv6 handling for `--linked`, so squash needs no bespoke password prompt.
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

    // 6. The project `.env` loads after the
    // flag-group validation above — so a `SUPABASE_YES` set only in `supabase/.env` auto-confirms
    // the remote-baseline prompt, but a flag conflict still surfaces before any `.env` read.
    const projectEnv = yield* loadProjectEnv(fs, path, cliSettings.workdir);
    // Make an allowlisted `supabase/.env` registry override visible to the
    // synchronous `process.env` reader in `getRegistryImageUrl`, reverted
    // when this scope closes. The project `.env` is applied
    // before any container starts, and each of squash's three
    // pg_dump containers resolves its image through the same registry-mirror lookup —
    // so a dotenv-only mirror override reaches all three dumps below.
    yield* applyProjectEnv(projectEnv);
    const yes = yield* resolveYesWithProjectEnv(projectEnv);

    // 7. `--version` validation happens AFTER db-config resolution.
    const version = Option.getOrElse(flags.version, () => "");
    if (version.length > 0) {
      if (parseMigrationVersion(version) === undefined) {
        // Bare message — squash does NOT inherit repair's "failed to parse <v>: " prefix.
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

    // 8. Squash local migrations.
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

    // 9. Local target: suggest `migration repair` instead of touching the remote history.
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

    // 10. Remote target: prompt before touching the remote history table. A DECLINED prompt is
    // still a SUCCESS path here (returns cleanly, not a cancellation) — unlike
    // repair/fetch/down, so this never raises `OperationCanceledError`.
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
