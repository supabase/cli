import { Effect, FileSystem, Option, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcessSpawner as ChildProcessSpawnerType } from "effect/unstable/process/ChildProcessSpawner";

import { cobraMutuallyExclusiveErrorMessage } from "../../../../shared/cli/cobra-flag-groups.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import {
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyNetworkIdFlag,
  legacyResolveYesWithProjectEnv,
} from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { LegacyCliSettings } from "../../../config/legacy-cli-settings.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { legacyAqua, legacyBold } from "../../../shared/legacy-colors.ts";
import {
  legacyBuildLocalDbContainerInputs,
  type LegacyLocalDbContainerInputs,
} from "../../../shared/db-bootstrap/local-container-inputs.ts";
import {
  legacyResolveDbSetupPrelude,
  legacySetupDatabase,
} from "../../../shared/db-bootstrap/db-setup.ts";
import { legacyWaitForHealthyServices } from "../../../shared/db-bootstrap/health-check.ts";
import {
  legacyBuildShadowSetupDatabaseInput,
  legacyConnectShadowDatabase,
  legacyCreateShadowDatabase,
  legacyRemoveShadowDatabase,
  legacyShadowRunInputFromLocalContainerInputs,
} from "../../../shared/db-bootstrap/shadow-database.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import {
  legacyApplyProjectEnv,
  legacyLoadProjectEnv,
  legacyReadDbToml,
  type LegacyDbTomlValues,
} from "../../../shared/legacy-db-config.toml-read.ts";
import type { LegacyResolvedDbConfig } from "../../../shared/legacy-db-config.types.ts";
import {
  LegacyDbConnection,
  type LegacyPgConnInput,
} from "../../../shared/legacy-db-connection.service.ts";
import { resolveLegacyDbTargetFlags } from "../../../shared/legacy-db-target-flags.ts";
import { LegacyDebugLogger } from "../../../shared/legacy-debug-logger.service.ts";
import {
  legacyErrorMessage,
  legacyRelativizeErrorMessage,
} from "../../../shared/legacy-error-message.ts";
import {
  legacyApplyMigrations,
  LegacyMigrationApplyError,
} from "../../../shared/legacy-migration-apply.ts";
import {
  INSERT_MIGRATION_VERSION,
  LEGACY_DELETE_MIGRATION_BEFORE,
  legacyCreateMigrationTable,
  legacyLoadLocalVersions,
  legacyLoadPartialMigrations,
  legacyReadMigrationFile,
  legacyResolveMigrationFile,
} from "../../../shared/legacy-migration-history.ts";
import { legacyParseMigrationVersion } from "../../../shared/legacy-migration-timestamp.format.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import {
  LegacyMigrationFileNotFoundError,
  LegacyMigrationInvalidVersionError,
  LegacyMigrationPasswordFlagsError,
  LegacyMigrationTargetFlagsError,
} from "../migration.errors.ts";
import { legacyMigrationConfirm } from "../migration.prompt.ts";
import type { LegacyMigrationSquashFlags } from "./squash.command.ts";
import { LEGACY_SQUASH_SEPARATOR_COMMENT, legacySquashLineByLineDiff } from "./squash.diff.ts";
import { legacySquashDumpSchema, legacySquashDumpSchemaToString } from "./squash.dump.ts";
import {
  LegacyMigrationSquashBaselineError,
  LegacyMigrationSquashMissingVersionError,
  LegacyMigrationSquashWriteError,
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
  localInputs: LegacyLocalDbContainerInputs,
  toml: LegacyDbTomlValues,
) {
  const resolvedShadowImage = yield* localInputs.resolvePostgresImage;
  const shadowInput = legacyShadowRunInputFromLocalContainerInputs(
    localInputs,
    resolvedShadowImage,
    toml,
    fs,
    path,
  );
  const connConfig: LegacyPgConnInput = {
    host: localInputs.context.hostname,
    port: toml.shadowPort,
    user: "postgres",
    password: toml.password,
    database: "postgres",
  };
  // The pin-resolved (not yet registry-mapped) image every
  // `pg_dump` container below uses; `legacySquashDumpSchema` applies the registry mirror itself.
  const image = localInputs.bootstrapConfig.postgresImage;

  yield* Effect.acquireUseRelease(
    legacyCreateShadowDatabase(spawner, shadowInput),
    (handle) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* legacyWaitForHealthyServices(spawner, [handle.containerId], {
            timeoutSeconds: shadowInput.healthTimeoutSeconds,
          });
          const session = yield* legacyConnectShadowDatabase(connConfig);
          const resolved = yield* legacyResolveDbSetupPrelude(shadowInput.setup);
          yield* legacySetupDatabase(
            spawner,
            legacyBuildShadowSetupDatabaseInput(
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

          const before = yield* legacySquashDumpSchemaToString({
            image,
            conn: connConfig,
            schema: ["auth", "storage"],
            projectEnvValues: localInputs.context.projectEnvValues,
          });
          yield* legacyApplyMigrations(
            session,
            fs,
            path,
            migrations,
            (message) => new LegacyMigrationApplyError({ message }),
          );
          const after = yield* legacySquashDumpSchemaToString({
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
                    new LegacyMigrationSquashWriteError({
                      message: `failed to open migration file: ${legacyRelativizeErrorMessage(legacyErrorMessage(cause), targetPath, targetRel)}`,
                    }),
                ),
              );
              // The full dump — NO schema restriction — streamed straight into the
              // already-truncated file at constant memory. The underlying failure here is
              // the docker-log-stream write into the file handle,
              // not the line-diff writer below, so it byte-matches "failed to copy
              // docker logs:" rather than "failed to write line:".
              yield* legacySquashDumpSchema({
                image,
                conn: connConfig,
                schema: [],
                projectEnvValues: localInputs.context.projectEnvValues,
                onStdout: (chunk) =>
                  file.writeAll(chunk).pipe(
                    Effect.mapError(
                      (cause) =>
                        new LegacyMigrationSquashWriteError({
                          message: `failed to copy docker logs: ${legacyErrorMessage(cause)}`,
                        }),
                    ),
                  ),
              });
              // The separator and the auth/storage line diff write sequentially to the
              // SAME handle, with nothing observable
              // between the two writes — combined into one `writeAll` here.
              const tail =
                LEGACY_SQUASH_SEPARATOR_COMMENT + legacySquashLineByLineDiff(before, after);
              yield* file.writeAll(new TextEncoder().encode(tail)).pipe(
                Effect.mapError(
                  (cause) =>
                    new LegacyMigrationSquashWriteError({
                      message: `failed to write line: ${legacyRelativizeErrorMessage(legacyErrorMessage(cause), targetPath, targetRel)}`,
                    }),
                ),
              );
            }),
          );
        }),
      ),
    (handle) => legacyRemoveShadowDatabase(spawner, handle.containerId),
  );
});

/** Outcome of {@link squashToVersion} — feeds the machine-mode payload. */
interface LegacySquashToVersionResult {
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
  localInputs: LegacyLocalDbContainerInputs,
  toml: LegacyDbTomlValues,
) {
  const output = yield* Output;
  const migrations = yield* legacyLoadPartialMigrations(fs, path, migrationsDir, version);
  if (migrations.length === 0) {
    return yield* Effect.fail(
      new LegacyMigrationSquashMissingVersionError({ message: "version not found" }),
    );
  }

  const local = migrations[migrations.length - 1]!;
  const rel = path.relative(workdir, local);
  if (migrations.length === 1) {
    yield* output.raw(`${legacyBold(rel)} is already the earliest migration.\n`, "stderr");
    return {
      alreadyEarliest: true,
      target: rel,
      removed: [],
      removeFailures: [],
    } satisfies LegacySquashToVersionResult;
  }

  yield* squashMigrations(spawner, fs, path, workdir, migrations, localInputs, toml);
  yield* output.raw(`Squashed local migrations to ${legacyBold(rel)}\n`, "stderr");

  const removed: Array<string> = [];
  const removeFailures: Array<{ readonly path: string; readonly message: string }> = [];
  for (const merged of migrations.slice(0, -1)) {
    const mergedRel = path.relative(workdir, merged);
    yield* fs.remove(merged).pipe(
      Effect.matchEffect({
        onFailure: (cause) => {
          const message = legacyRelativizeErrorMessage(
            legacyErrorMessage(cause),
            merged,
            mergedRel,
          );
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
  } satisfies LegacySquashToVersionResult;
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
  cfg: LegacyResolvedDbConfig,
  dnsResolver: "native" | "https",
  version: string,
) {
  const output = yield* Output;
  const connection = yield* LegacyDbConnection;
  const debugLogger = yield* LegacyDebugLogger;

  let resolvedVersion = version;
  if (resolvedVersion.length === 0) {
    // A read failure only logs via the debug logger
    // and leaves `version` empty; it never aborts the baseline.
    const local = yield* legacyLoadLocalVersions(fs, path, migrationsDir).pipe(
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
      yield* legacyCreateMigrationTable(session);

      const resolvedFile = yield* legacyResolveMigrationFile(
        fs,
        path,
        migrationsDir,
        resolvedVersion,
      );
      if (Option.isNone(resolvedFile)) {
        return yield* Effect.fail(
          new LegacyMigrationFileNotFoundError({
            message: `glob supabase/migrations/${resolvedVersion}_*.sql: file does not exist`,
          }),
        );
      }
      const m = yield* legacyReadMigrationFile(fs, path, resolvedFile.value);

      // Data statements only, no schema mutation, so
      // (matching `migration repair`'s own `updateMigrationTable`) wrapped in an explicit
      // transaction for atomicity between the DELETE and the INSERT.
      const txn = Effect.gen(function* () {
        yield* session.exec("BEGIN");
        yield* session.query(LEGACY_DELETE_MIGRATION_BEFORE, [m.version]);
        yield* session.query(INSERT_MIGRATION_VERSION, [m.version, m.name, m.statements]);
        yield* session.exec("COMMIT");
      });
      yield* txn.pipe(
        Effect.tapError(() => session.exec("ROLLBACK").pipe(Effect.ignore)),
        Effect.mapError(
          (cause) =>
            new LegacyMigrationSquashBaselineError({
              message: `failed to update migration history: ${legacyErrorMessage(cause)}`,
            }),
        ),
      );
    }),
  );

  return resolvedVersion;
});

const runSquash = Effect.fnUntraced(function* (
  flags: LegacyMigrationSquashFlags,
  target: ReturnType<typeof resolveLegacyDbTargetFlags>,
) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const cliSettings = yield* LegacyCliSettings;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* LegacyDnsResolverFlag;
  const debug = yield* LegacyDebugFlag;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runtimeInfo = yield* RuntimeInfo;
  const networkIdFlag = yield* LegacyNetworkIdFlag;

  // Resolved linked ref, captured so the post-run finalizer caches the project
  // (GET /v1/projects/{ref}).
  let linkedRefForCache: string | undefined;

  yield* Effect.gen(function* () {
    // 1. Flag groups — parse-time mutual-exclusivity check, ahead of the root
    // pre-run.
    if (target.setFlags.length > 1) {
      return yield* Effect.fail(
        new LegacyMigrationTargetFlagsError({
          message: cobraMutuallyExclusiveErrorMessage(
            ["db-url", "linked", "local"],
            target.setFlags,
          ),
        }),
      );
    }
    if (Option.isSome(flags.dbUrl) && Option.isSome(flags.password)) {
      return yield* Effect.fail(
        new LegacyMigrationPasswordFlagsError({
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
        new LegacyMigrationTargetFlagsError({
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
      const projectRefResolver = yield* LegacyProjectRefResolver;
      linkedRef = yield* projectRefResolver.loadProjectRef(flags.projectRef);
      linkedRefForCache = linkedRef;
    }
    const toml = yield* legacyReadDbToml(fs, path, cliSettings.workdir, linkedRef);
    if (toml.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${toml.appliedRemote}]\n`, "stderr");
    }

    // 4. The shadow's own container spec — always built, and built BEFORE `resolver.resolve()`
    // below, matching `diff.handler.ts`'s identical
    // rationale: all config load/validation happens ahead of the actual connection resolution.
    const localInputs = yield* legacyBuildLocalDbContainerInputs(
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
    const projectEnv = yield* legacyLoadProjectEnv(fs, path, cliSettings.workdir);
    // Make an allowlisted `supabase/.env` registry override visible to the
    // synchronous `process.env` reader in `legacyGetRegistryImageUrl`, reverted
    // when this scope closes. The project `.env` is applied
    // before any container starts, and each of squash's three
    // pg_dump containers resolves its image through the same registry-mirror lookup —
    // so a dotenv-only mirror override reaches all three dumps below.
    yield* legacyApplyProjectEnv(projectEnv);
    const yes = yield* legacyResolveYesWithProjectEnv(projectEnv);

    // 7. `--version` validation happens AFTER db-config resolution.
    const version = Option.getOrElse(flags.version, () => "");
    if (version.length > 0) {
      if (legacyParseMigrationVersion(version) === undefined) {
        // Bare message — squash does NOT inherit repair's "failed to parse <v>: " prefix.
        return yield* Effect.fail(
          new LegacyMigrationInvalidVersionError({ message: "invalid version number" }),
        );
      }
      const versionFile = yield* legacyResolveMigrationFile(fs, path, migrationsDir, version);
      if (Option.isNone(versionFile)) {
        return yield* Effect.fail(
          new LegacyMigrationFileNotFoundError({
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
        yield* output.raw(`Finished ${legacyAqua("supabase migration squash")}.\n`);
        yield* output.raw(
          `Run ${legacyAqua("supabase migration repair --status applied")} to update your remote migration history table.\n`,
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
    // repair/fetch/down, so this never raises `LegacyOperationCanceledError`.
    const confirmed = yield* legacyMigrationConfirm("Update remote migration history table?", {
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
      yield* output.raw(`Finished ${legacyAqua("supabase migration squash")}.\n`);
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
    // command run: `legacyApplyProjectEnv` registers a finalizer that reverts it.
    Effect.scoped,
  );
});

export const legacyMigrationSquash = Effect.fn("legacy.migration.squash")(function* (
  flags: LegacyMigrationSquashFlags,
) {
  const telemetryState = yield* LegacyTelemetryState;
  const cliArgs = yield* CliArgs;
  const target = resolveLegacyDbTargetFlags(cliArgs.args);
  yield* runSquash(flags, target).pipe(Effect.ensuring(telemetryState.flush));
});
