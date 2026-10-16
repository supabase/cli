import { Effect, FileSystem, Option, Path, Ref } from "effect";

import {
  DnsResolverFlag,
  resolveExperimentalWithProjectEnv,
} from "../../../command-internal/global-flags.ts";
import {
  hostedMutationPreapproval,
  requireHostedMutationConsent,
} from "../../../command-internal/hosted-consent/hosted-consent.ts";
import { planDbSeed } from "../../../command-internal/seed-remote-consent.ts";
import { sqlFilesGlob } from "../../../command-internal/sql-files-glob.ts";
import { resolveTarget } from "../../../command-internal/target/resolve-target.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { CliConfigValues } from "../../../config/cli-config-values.service.ts";
import { aqua, yellow } from "../../../command-internal/colors.ts";
import { resetLocalDatabase } from "../../../command-internal/db-bootstrap/reset-local-database.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import {
  checkDbToml,
  loadProjectEnvValues,
} from "../../../command-internal/db-config.toml-read.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import {
  experimentalSchemaPathsIgnoredWarning,
  ignoresExperimentalSchemaPaths,
} from "../../../command-internal/migrate-and-seed.ts";
import { applyMigrations, applySchemaFiles } from "../../../command-internal/migration-apply.ts";
import { parseMigrationVersion } from "../../../command-internal/migration-timestamp.format.ts";
import { listLocalMigrations } from "../../../command-internal/migration-list.ts";
import { pathMatch } from "../../../command-internal/path-match.ts";
import { getPendingSeeds, seedData } from "../../../command-internal/seed-ops.ts";
import { upsertVaultSecrets } from "../../../command-internal/vault.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { dropUserSchemas } from "../shared/drop-schemas.ts";
import type { DbResetFlags } from "./reset.command.ts";
import {
  DbResetApplyError,
  DbResetInvalidVersionError,
  DbResetLastFlagError,
  DbResetMigrationFileError,
  DbResetSeedFlagsError,
  DbResetVersionFlagsError,
} from "./reset.errors.ts";

const NO_SQL_PATHS: ReadonlyArray<string> = [];

const MIGRATE_FILE_PATTERN = /^([0-9]+)_(.*)\.sql$/u;

const applyError = (message: string, suggestion?: string) =>
  new DbResetApplyError({ message, ...(suggestion !== undefined ? { suggestion } : {}) });

/** Formats the "to version" / "..." suffix for the reset log line. */
const toLogMessage = (version: string): string =>
  version.length > 0 ? ` to version: ${version}` : "...";

/**
 * `supabase db reset` — reinitializes a database from local migrations (+ seed). The local
 * composition is hoisted into `resetLocalDatabase` so `db schema declarative`'s recovery reset
 * can reuse it; a versionless `--experimental` remote reset with pg-delta disabled takes the
 * declarative schema-files branch instead of replaying migrations, matching the local path.
 */
export const dbReset = Effect.fn("db.reset")(function* (flags: DbResetFlags) {
  const output = yield* Output;
  const resolver = yield* DbConfigResolver;
  const dbConn = yield* DbConnection;
  const cliSettings = yield* CommandSettings;
  const telemetryState = yield* TelemetryState;
  const linkedProjectCache = yield* LinkedProjectCache;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* DnsResolverFlag;
  const configValues = yield* CliConfigValues;
  const noSeed = Option.getOrElse(flags.noSeed, () => false);
  const sqlPaths = Option.getOrElse(flags.sqlPaths, () => NO_SQL_PATHS);

  const workdir = cliSettings.workdir;
  const migrationsDir = path.join(workdir, "supabase", "migrations");
  const projectEnv = yield* loadProjectEnvValues(fs, path, workdir);
  const experimental = yield* resolveExperimentalWithProjectEnv(projectEnv);
  const linkedRefForCache = yield* Ref.make(Option.none<string>());

  const body = Effect.gen(function* () {
    // `--last` is an unsigned flag, so a negative value should be rejected; `Flag.Int` here
    // accepts it, so reject it explicitly rather than silently resetting the full history.
    if (Option.isSome(flags.last) && flags.last.value < 0) {
      return yield* new DbResetLastFlagError({
        message: `invalid argument "${flags.last.value}" for "--last" flag: expected an unsigned integer`,
      });
    }
    // Mutually-exclusive version/last group.
    if (Option.isSome(flags.version) && Option.isSome(flags.last)) {
      return yield* new DbResetVersionFlagsError({
        message:
          "if any flags in the group [last version] are set none of the others can be; [last version] were all set",
      });
    }

    // `--no-seed` conflicts with `--sql-paths`, and each `--sql-paths` value
    // must be non-empty.
    if (noSeed && sqlPaths.length > 0) {
      return yield* new DbResetSeedFlagsError({
        message: "--no-seed cannot be used with --sql-paths",
        suggestion: `Use either ${aqua("--no-seed")} to skip seeding or ${aqua(
          "--sql-paths",
        )} to override seed files, not both.`,
      });
    }
    if (sqlPaths.some((p) => p.length === 0)) {
      return yield* new DbResetSeedFlagsError({
        message: "--sql-paths requires a non-empty path or glob pattern",
        suggestion: `Pass a non-empty file path or glob pattern to ${aqua("--sql-paths")}.`,
      });
    }

    // Version / last resolution, filesystem only.
    let resolvedVersion = "";
    // An empty --version skips validation entirely, falling through as if no
    // version were given at all.
    if (Option.isSome(flags.version) && flags.version.value.length > 0) {
      const v = flags.version.value;
      // Rejects non-numeric text and values outside the int64 range; shared with `migration
      // repair`'s own version parse via `parseMigrationVersion`.
      if (parseMigrationVersion(v) === undefined) {
        // The bare "invalid version number" is returned unwrapped; the
        // `failed to parse <v>:` wrapper belongs to `migration repair` only.
        return yield* new DbResetInvalidVersionError({
          message: "invalid version number",
        });
      }
      // Validated by globbing `supabase/migrations/<version>_*.sql` directly, with no filtering,
      // so a deprecated first migration that `listLocalMigrations` excludes is still accepted.
      const entries = yield* fs
        .readDirectory(migrationsDir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      const found = entries.some((name) => pathMatch(`${v}_*.sql`, path.basename(name)).matched);
      if (!found) {
        return yield* new DbResetMigrationFileError({
          message: `glob supabase/migrations/${v}_*.sql: file does not exist`,
        });
      }
      resolvedVersion = v;
    } else if (Option.isSome(flags.last) && flags.last.value > 0) {
      const locals = yield* listLocalMigrations(fs, path, migrationsDir);
      const versions = locals.flatMap((p) => {
        const m = MIGRATE_FILE_PATTERN.exec(path.basename(p));
        return m?.[1] !== undefined ? [m[1]] : [];
      });
      const total = versions.length;
      const last = flags.last.value;
      resolvedVersion = versions[total - last - 1] ?? "-";
    }

    const target = yield* resolveTarget({
      local: flags.local,
      linked: flags.linked,
      dbUrl: flags.dbUrl,
      projectRef: flags.projectRef,
    });

    // Recorded before the fallible connection resolution, so the post-run cache finalizer still
    // fires when it fails mid-way (merged config, temp-role mint, connection).
    if (target.kind === "linked") {
      yield* Ref.set(linkedRefForCache, Option.some(target.ref));
    }

    const cfg = yield* resolver.resolveConnection({
      target,
      dnsResolver,
      password: Option.none(),
      networkBanRemoval: yield* hostedMutationPreapproval,
    });

    yield* Effect.annotateCurrentSpan({
      "db.conn_type": target.kind,
      "db.is_local": cfg.isLocal,
      ...(resolvedVersion !== "" ? { "migration.version": resolvedVersion } : {}),
    });

    // Local target: the composition (container recreate, storage-health gate, bucket seeding,
    // git-branch line) is hoisted into `resetLocalDatabase`, shared with `db schema declarative`'s
    // recovery reset; this call site keeps only version/seed-flags plumbing and the JSON envelope.
    if (cfg.isLocal) {
      yield* resetLocalDatabase({ version: resolvedVersion });
      if (output.format !== "text") {
        yield* output.success("Reset local database.", { version: resolvedVersion });
      }
      return;
    }

    if (sqlPaths.length > 0) {
      yield* output.raw(
        `${yellow("WARNING:")} --sql-paths overrides [db.seed].sql_paths and seeds the remote database.\n`,
        "stderr",
      );
    }

    const linkedRef = target.kind === "linked" ? target.ref : undefined;

    // Decodes the whole config with env-expansion and weak-typed boolean parsing, applies
    // `SUPABASE_*` overrides, merges a matching `[remotes.<ref>]` block, and decrypts every
    // `encrypted:` secret — aborting here, before the destructive prompt, on any invalid config.
    const toml = yield* checkDbToml(fs, path, workdir, linkedRef);
    if (toml.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${toml.appliedRemote}]\n`, "stderr");
    }
    const vaultSecrets = toml.vault;
    const resolvedConfig = yield* configValues.load({
      workdir,
      projectRef: Option.fromNullishOr(linkedRef),
    });
    const seedPlan = yield* planDbSeed(resolvedConfig, { workdir, ref: linkedRef ?? "" });
    const seedEnabled = seedPlan.input.enabled;
    const seedSqlPaths = seedPlan.input.sqlPaths;
    if (
      ignoresExperimentalSchemaPaths({
        experimental,
        version: resolvedVersion,
        pgDeltaEnabled: toml.pgDelta.enabled,
        schemaPaths: toml.schemaPaths,
      })
    ) {
      yield* output.raw(experimentalSchemaPathsIgnoredWarning, "stderr");
    }

    // Takes the schema-files branch when `--experimental`/`SUPABASE_EXPERIMENTAL` is set, no
    // version is resolved, and pg-delta is disabled — a hard if/else-if, so an empty
    // `schema_paths = []` applies nothing rather than falling back to migrations.
    const useSchemaFiles = experimental && resolvedVersion === "" && !toml.pgDelta.enabled;
    const seedFiles = seedEnabled
      ? (yield* sqlFilesGlob(fs, path, seedSqlPaths, workdir)).files
      : [];
    const vaultCount = vaultSecrets.filter((secret) => secret.resolved).length;
    yield* requireHostedMutationConsent({
      action: `Reset the remote database${resolvedVersion === "" ? "" : ` to version ${resolvedVersion}`}`,
      details: [
        "drop every user schema",
        ...(vaultCount > 0
          ? [`upsert ${vaultCount} vault secret${vaultCount === 1 ? "" : "s"}`]
          : []),
        useSchemaFiles
          ? "apply the declarative schema files"
          : `apply local migrations${resolvedVersion === "" ? "" : ` up to version ${resolvedVersion}`}`,
        ...Option.toArray(Option.fromNullishOr(seedPlan.detail(seedFiles))),
      ],
    });
    yield* output.raw(`Resetting remote database${toLogMessage(resolvedVersion)}\n`, "stderr");

    yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* dbConn.connect(cfg.conn, { isLocal: false, dnsResolver });
        // Reset everything: drop user schemas → upsert vault → migrate + seed.
        yield* dropUserSchemas(session, applyError);
        yield* upsertVaultSecrets(session, vaultSecrets);

        if (useSchemaFiles) {
          // Threaded through so a `SUPABASE_SCANNER_BUFFER_SIZE` set only in `supabase/.env` is
          // honored here (see `checkScannerBufferSize` in `migration-apply.ts`).
          yield* applySchemaFiles(
            session,
            fs,
            path,
            workdir,
            toml.schemaPaths,
            applyError,
            projectEnv,
          );
        } else if (toml.migrationsEnabled) {
          const locals = yield* listLocalMigrations(fs, path, migrationsDir);
          // Selects every migration when no version is set, otherwise only versions <= the target.
          const pending = locals.filter((p) => {
            if (resolvedVersion === "") return true;
            const m = MIGRATE_FILE_PATTERN.exec(path.basename(p));
            return m?.[1] !== undefined && m[1] <= resolvedVersion;
          });
          yield* Effect.annotateCurrentSpan({ "migration.count": pending.length });
          yield* applyMigrations(session, fs, path, pending, applyError);
        }

        if (seedEnabled) {
          const seeds = yield* getPendingSeeds(session, fs, path, seedSqlPaths, workdir);
          yield* Effect.annotateCurrentSpan({ "seed.count": seeds.length });
          yield* seedData(session, fs, workdir, path, seeds, applyError);
        }
      }).pipe(Effect.withSpan("db.reset.applyMigrations")),
    );

    if (output.format !== "text") {
      yield* output.success("Reset remote database.", { version: resolvedVersion });
    }
  });

  yield* body.pipe(
    Effect.ensuring(
      Ref.get(linkedRefForCache).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (ref) => (ref === "" ? Effect.void : linkedProjectCache.cache(ref)),
          }),
        ),
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
