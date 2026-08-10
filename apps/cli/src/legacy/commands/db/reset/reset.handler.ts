import { Effect, FileSystem, Option, Path } from "effect";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyDnsResolverFlag } from "../../../../shared/legacy/global-flags.ts";
import {
  legacyResolveExperimentalWithProjectEnv,
  legacyResolveYesWithProjectEnv,
} from "../../../../shared/legacy/global-flags.ts";
import { legacyPromptYesNo } from "../../../../shared/legacy/legacy-prompt-yes-no.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../../../../shared/output/errors.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { legacyAqua, legacyYellow } from "../../../shared/legacy-colors.ts";
import { legacyResolveResetSeedConfig } from "../../../shared/db-bootstrap/db-setup.ts";
import { legacyResetLocalDatabase } from "../../../shared/db-bootstrap/reset-local-database.ts";
import { legacyParseBoolEnv } from "../../../shared/legacy-diff-engine.ts";
import { redactLegacyConnectionString } from "../../../shared/legacy-db-config.parse.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import {
  legacyApplyProjectEnv,
  legacyCheckDbToml,
  legacyLoadProjectEnv,
} from "../../../shared/legacy-db-config.toml-read.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import {
  legacyResolveLocalProjectId,
  legacySanitizeProjectId,
} from "../../../shared/legacy-docker-ids.ts";
import {
  legacyApplyMigrations,
  legacyApplySchemaFiles,
} from "../../../shared/legacy-migration-apply.ts";
import { legacyParseMigrationVersion } from "../../../shared/legacy-migration-timestamp.format.ts";
import {
  legacyListLocalMigrations,
  legacyTryCacheMigrationsCatalog,
} from "../../../shared/legacy-pgdelta.cache.ts";
import { type LegacyPgDeltaContext } from "../../../shared/legacy-pgdelta.ts";
import { legacyPathMatch } from "../../../shared/legacy-path-match.ts";
import { legacyToPostgresURL } from "../../../shared/legacy-postgres-url.ts";
import { resolveLegacyDbTargetFlags } from "../../../shared/legacy-db-target-flags.ts";
import { legacyGetPendingSeeds, legacySeedData } from "../../../shared/legacy-seed-ops.ts";
import { legacyUpsertVaultSecrets } from "../../../shared/legacy-vault.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyDropUserSchemas } from "../shared/legacy-drop-schemas.ts";
import type { LegacyDbResetFlags } from "./reset.command.ts";
import {
  LegacyDbResetApplyError,
  LegacyDbResetCancelledError,
  LegacyDbResetInvalidVersionError,
  LegacyDbResetLastFlagError,
  LegacyDbResetMigrationFileError,
  LegacyDbResetSeedFlagsError,
  LegacyDbResetTargetFlagsError,
  LegacyDbResetVersionFlagsError,
} from "./reset.errors.ts";

const MIGRATE_FILE_PATTERN = /^([0-9]+)_(.*)\.sql$/u;

const applyError = (message: string, suggestion?: string) =>
  new LegacyDbResetApplyError({ message, ...(suggestion !== undefined ? { suggestion } : {}) });

/** Go's `toLogMessage` (`internal/db/reset/reset.go:88-91`). */
const toLogMessage = (version: string): string =>
  version.length > 0 ? ` to version: ${version}` : "...";

/**
 * `supabase db reset` — reinitialise a database from local migrations (+ seed).
 *
 * Strict 1:1 port of `apps/cli-go/internal/db/reset/reset.go`. Fully native — no
 * remaining Go delegation on either target. The local path's container-recreate
 * primitives are native (the hidden `db __db-bootstrap` Go seam this used to
 * delegate to, CLI-1325 Stage 3's documented interim, is gone — CLI-1955), and the
 * local-reset composition itself is hoisted into `legacyResetLocalDatabase`
 * (`legacy/shared/db-bootstrap/reset-local-database.ts`, CLI-2062) so `db schema
 * declarative`'s smart-target/sync recovery reset can call it in-process too,
 * instead of shelling out to a second `supabase-go` child. The remote target's
 * `--experimental` schema-files path — the last remaining Go delegation on this
 * command — is now also native (`legacyApplySchemaFiles`, CLI-1958): a versionless
 * `--experimental`/`SUPABASE_EXPERIMENTAL` remote reset with pg-delta NOT enabled
 * takes Go's EXPERIMENTAL declarative schema-files branch of `apply.MigrateAndSeed`
 * instead of replaying timestamped migrations, mirroring `legacyMigrateAndSeed`'s
 * already-native local-side implementation of the exact same Go branch (reused by
 * both the PG14 and PG15 recreate paths).
 */
export const legacyDbReset = Effect.fn("legacy.db.reset")(function* (flags: LegacyDbResetFlags) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const dbConn = yield* LegacyDbConnection;
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cliArgs = yield* CliArgs;
  const dnsResolver = yield* LegacyDnsResolverFlag;

  const workdir = cliConfig.workdir;
  const migrationsDir = path.join(workdir, "supabase", "migrations");
  // Go's `ParseDatabaseConfig` runs `loadNestedEnv` (which `os.Setenv`s each project-.env key)
  // before `reset.Run` reads `viper.GetBool("YES")` / `viper.GetBool("EXPERIMENTAL")`, so a
  // `SUPABASE_YES` / `SUPABASE_EXPERIMENTAL` set only in `supabase/.env` is honored. Load the
  // project env first and resolve both gates against it, as `db pull` does for `yes`.
  const projectEnv = yield* legacyLoadProjectEnv(fs, path, workdir);
  const yes = yield* legacyResolveYesWithProjectEnv(projectEnv);
  const experimental = yield* legacyResolveExperimentalWithProjectEnv(projectEnv);
  let linkedRefForCache: string | undefined;

  const body = Effect.gen(function* () {
    // Go's `loadNestedEnv` (`os.Setenv`) makes every project-`.env` key visible to the
    // WHOLE reset run, not just the flag-gate reads above — in particular
    // `legacyGetRegistryImageUrl` / `legacyPgDeltaNpmRegistryOption` read
    // `SUPABASE_INTERNAL_IMAGE_REGISTRY` / `PGDELTA_NPM_REGISTRY` straight from
    // `process.env` for the pg-delta catalog export below (review CLI-1958). `db push`
    // (`push.handler.ts`) scopes this the same way, as the first statement of its own
    // `body` — mirror that exactly so a private/air-gapped registry configured only in
    // `supabase/.env` reaches the catalog export instead of silently falling back to the
    // default registries.
    yield* legacyApplyProjectEnv(projectEnv);
    const target = resolveLegacyDbTargetFlags(cliArgs.args);
    // cobra MarkFlagsMutuallyExclusive("db-url", "linked", "local").
    if (target.setFlags.length > 1) {
      return yield* Effect.fail(
        new LegacyDbResetTargetFlagsError({
          message: `if any flags in the group [db-url linked local] are set none of the others can be; [${target.setFlags.join(" ")}] were all set`,
        }),
      );
    }
    // Go declares `--last` as `UintVar`, so cobra rejects a negative at parse time
    // (`Flag.integer` here accepts it). Reject it the same way rather than silently
    // treating it as "no --last" and resetting the full history.
    if (Option.isSome(flags.last) && flags.last.value < 0) {
      return yield* Effect.fail(
        new LegacyDbResetLastFlagError({
          message: `invalid argument "${flags.last.value}" for "--last" flag: strconv.ParseUint: parsing "${flags.last.value}": invalid syntax`,
        }),
      );
    }
    // cobra MarkFlagsMutuallyExclusive("version", "last") — alphabetical group.
    if (Option.isSome(flags.version) && Option.isSome(flags.last)) {
      return yield* Effect.fail(
        new LegacyDbResetVersionFlagsError({
          message:
            "if any flags in the group [last version] are set none of the others can be; [last version] were all set",
        }),
      );
    }

    // Go's validateDbResetSeedFlags (PreRunE): `--no-seed` conflicts with
    // `--sql-paths`, and each `--sql-paths` value must be non-empty.
    if (flags.noSeed && flags.sqlPaths.length > 0) {
      return yield* Effect.fail(
        new LegacyDbResetSeedFlagsError({
          message: "--no-seed cannot be used with --sql-paths",
          suggestion: `Use either ${legacyAqua("--no-seed")} to skip seeding or ${legacyAqua(
            "--sql-paths",
          )} to override seed files, not both.`,
        }),
      );
    }
    if (flags.sqlPaths.some((p) => p.length === 0)) {
      return yield* Effect.fail(
        new LegacyDbResetSeedFlagsError({
          message: "--sql-paths requires a non-empty path or glob pattern",
          suggestion: `Pass a non-empty file path or glob pattern to ${legacyAqua("--sql-paths")}.`,
        }),
      );
    }
    // Go's warnRemoteResetSeedOverride (PreRunE): a remote target flag + --sql-paths.
    if (
      flags.sqlPaths.length > 0 &&
      (target.setFlags.includes("linked") || target.setFlags.includes("db-url"))
    ) {
      yield* output.raw(
        `${legacyYellow("WARNING:")} --sql-paths overrides [db.seed].sql_paths and seeds the remote database selected by --linked or --db-url.\n`,
        "stderr",
      );
    }

    // Version / last resolution (Go's reset.Run lines 34-52), filesystem only.
    let resolvedVersion = "";
    // Go's `len(version) > 0` guard (reset.go:34) skips validation entirely for an
    // empty --version, falling through as if no version were given at all.
    if (Option.isSome(flags.version) && flags.version.value.length > 0) {
      const v = flags.version.value;
      // Go's `strconv.Atoi` (== `ParseInt(s, 10, 0)`) rejects non-numeric text AND
      // values outside the int64 range; `legacyParseMigrationVersion` mirrors that
      // exactly (`migration repair` uses the same helper for its own version parse).
      if (legacyParseMigrationVersion(v) === undefined) {
        // Go's reset.Run returns the bare repair.ErrInvalidVersion (reset.go:35-36);
        // the `failed to parse <v>:` wrapper belongs to `migration repair` only.
        return yield* Effect.fail(
          new LegacyDbResetInvalidVersionError({
            message: "invalid version number",
          }),
        );
      }
      // Go validates the version with `repair.GetMigrationFile` (repair.go:90-100),
      // which globs `supabase/migrations/<version>_*.sql` DIRECTLY with no filtering —
      // so a deprecated first migration (e.g. `20200101000000_init.sql`) that
      // `legacyListLocalMigrations` excludes is still accepted. Mirror that with a raw
      // directory read + Go-glob match instead of the filtered migration listing.
      const entries = yield* fs
        .readDirectory(migrationsDir)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      const found = entries.some(
        (name) => legacyPathMatch(`${v}_*.sql`, path.basename(name)).matched,
      );
      if (!found) {
        return yield* Effect.fail(
          new LegacyDbResetMigrationFileError({
            message: `glob supabase/migrations/${v}_*.sql: file does not exist`,
          }),
        );
      }
      resolvedVersion = v;
    } else if (Option.isSome(flags.last) && flags.last.value > 0) {
      const locals = yield* legacyListLocalMigrations(fs, path, migrationsDir);
      const versions = locals.flatMap((p) => {
        const m = MIGRATE_FILE_PATTERN.exec(path.basename(p));
        return m?.[1] !== undefined ? [m[1]] : [];
      });
      const total = versions.length;
      const last = flags.last.value;
      resolvedVersion = last < total ? versions[total - last - 1]! : "-";
    }

    const connType = target.connType ?? "local";

    // Go's ParseDatabaseConfig runs LoadProjectRef BEFORE the fallible linked
    // resolution (db_url.go:87-95), and Execute() writes the linked-project cache
    // even when a later step errors (root.go:171-181). Pre-load the ref so the
    // post-run cache finalizer still fires when resolve fails mid-way (merged
    // config, temp-role mint, connection) — mirrors push.handler.
    if (connType === "linked") {
      const refResolver = yield* LegacyProjectRefResolver;
      linkedRefForCache = yield* refResolver.loadProjectRef(Option.none());
    }

    const cfg = yield* resolver.resolve({ dbUrl: flags.dbUrl, connType, dnsResolver });

    // Local target → native local reset. Mirrors `internal/db/reset/reset.go:57-77`;
    // the actual composition (running check, container recreate, storage-health gate,
    // bucket seeding, git-branch line) is hoisted into `legacyResetLocalDatabase`
    // (CLI-2062) — shared with `db schema declarative`'s in-process recovery reset —
    // so this call site stays a thin wrapper around it, keeping only the version/
    // seed-flags plumbing and the JSON envelope, which belong to this top-level
    // command alone (see that function's own header for why).
    if (cfg.isLocal) {
      yield* legacyResetLocalDatabase({
        version: resolvedVersion,
        seedFlags: { noSeed: flags.noSeed, sqlPaths: flags.sqlPaths },
      });
      if (output.format !== "text") {
        yield* output.success("Reset local database.", {
          target: "local",
          version: resolvedVersion,
        });
      }
      return;
    }

    // Re-confirm `linkedRefForCache` from the now-resolved `cfg.ref` for the native
    // remote path below. A `connType === "db-url"` target leaves `linkedRefForCache`
    // as whatever the pre-load block set (nothing, for `db-url`), since this
    // assignment only fires when linked.
    const linkedRef = Option.getOrUndefined(cfg.ref ?? Option.none());
    if (connType === "linked" && linkedRef !== undefined) linkedRefForCache = linkedRef;

    // Single Go-parity config load (`flags.LoadConfig` → `config.Load` + `Validate`):
    // decodes the whole config with Go's env-expansion + `strconv.ParseBool` weak typing
    // (so `enabled = "env(SEED_ENABLED)"` etc. load like Go), applies `SUPABASE_*`
    // AutomaticEnv overrides, merges a matching `[remotes.<ref>]` block, and decrypts every
    // `encrypted:` secret with the shell AND project-`.env` `DOTENV_PRIVATE_KEY*` keys —
    // aborting here (before the destructive prompt / `legacyDropUserSchemas`) on any
    // undecryptable/invalid config, exactly like Go's `LoadConfig` before ResetAll.
    const configRef = connType === "linked" && linkedRef !== undefined ? linkedRef : undefined;
    const toml = yield* legacyCheckDbToml(fs, path, workdir, configRef);
    if (toml.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${toml.appliedRemote}]\n`, "stderr");
    }
    const vaultSecrets = toml.vault;

    // Go's resetRemote: prompt (default false) → cancel, then ResetAll.
    const shouldReset = yield* legacyPromptYesNo(
      output,
      yes,
      "Do you want to reset the remote database?",
      false,
    );
    if (!shouldReset) {
      return yield* Effect.fail(
        new LegacyDbResetCancelledError({ message: CONTEXT_CANCELED_MESSAGE }),
      );
    }
    yield* output.raw(`Resetting remote database${toLogMessage(resolvedVersion)}\n`, "stderr");

    // Go connects with io.Discard, so NO "Connecting to ... database..." line.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* dbConn.connect(cfg.conn, { isLocal: false, dnsResolver });
        // ResetAll: drop user schemas → upsert vault → migrate + seed.
        yield* legacyDropUserSchemas(session, applyError);
        yield* legacyUpsertVaultSecrets(session, vaultSecrets);

        // Go's three-conjunct EXPERIMENTAL gate (`apply.MigrateAndSeed`, `apply.go:19`):
        // `--experimental`/`SUPABASE_EXPERIMENTAL` + no resolved version + pg-delta NOT
        // enabled. A hard `if`/`else if` in Go (`apply.go:19-27`) — taking the
        // schema-files branch means timestamped migrations never run at all, even when
        // the glob matches nothing (Go's `schema_paths = []` default silently applies
        // NOTHING rather than falling back to migrations — CLI-1958).
        const useSchemaFiles = experimental && resolvedVersion === "" && !toml.pgDelta.enabled;
        if (useSchemaFiles) {
          // `projectEnv` (loaded above, before `experimental`/`yes` resolve) is threaded
          // through so a `SUPABASE_SCANNER_BUFFER_SIZE` set only in `supabase/.env` is
          // honored here exactly like Go's `loadNestedEnv` (see
          // `checkScannerBufferSize`'s doc comment, `legacy-migration-apply.ts`).
          yield* legacyApplySchemaFiles(
            session,
            fs,
            path,
            workdir,
            toml.schemaPaths,
            applyError,
            projectEnv,
          );
        } else if (toml.migrationsEnabled) {
          const locals = yield* legacyListLocalMigrations(fs, path, migrationsDir);
          // LoadPartialMigrations filter: version === "" || v <= version.
          const pending = locals.filter((p) => {
            if (resolvedVersion === "") return true;
            const m = MIGRATE_FILE_PATTERN.exec(path.basename(p));
            return m?.[1] !== undefined && m[1] <= resolvedVersion;
          });
          yield* legacyApplyMigrations(session, fs, path, pending, applyError);
        }

        // `--no-seed` disables seeding; `--sql-paths` overrides [db.seed].sql_paths
        // and force-enables it (Go's applyDbResetSeedFlags). The two are mutually
        // exclusive (validated above). Same single home as the local path's identical
        // override (`legacyResolveResetSeedConfig`, `db-setup.ts`) — one implementation
        // of Go's `applyDbResetSeedFlags` for both targets, per "Hoist Before You
        // Duplicate" (`apps/cli/CLAUDE.md`).
        const resolvedSeed = legacyResolveResetSeedConfig(
          toml.seed,
          { noSeed: flags.noSeed, sqlPaths: flags.sqlPaths },
          path,
        );
        if (resolvedSeed.enabled) {
          const seeds = yield* legacyGetPendingSeeds(
            session,
            fs,
            path,
            resolvedSeed.sqlPaths,
            workdir,
          );
          yield* legacySeedData(session, fs, workdir, path, seeds, applyError);
        }

        // Go's `down.ResetAll` (`internal/migration/down/down.go:48-61`) — the function
        // `resetRemote` delegates to — best-effort caches the migrations catalog for
        // pg-delta right after `apply.MigrateAndSeed` succeeds, warning (never failing
        // the reset) on error. `pgcache.TryCacheMigrationsCatalog` itself no-ops when
        // `resolvedVersion` is non-empty (`len(version) > 0`, `pgcache/cache.go:73`) —
        // a versioned reset (`--version`/`--last`) never refreshes the cache — so gate
        // the call the same way rather than threading that check into the shared
        // native helper (already used by `db push`, which has no version concept).
        const cacheEnabled =
          resolvedVersion === "" &&
          (toml.pgDelta.enabled ||
            legacyParseBoolEnv(toml.envLookup("SUPABASE_EXPERIMENTAL_PG_DELTA")));
        const pgDeltaCtx: LegacyPgDeltaContext = {
          projectId: legacySanitizeProjectId(
            legacyResolveLocalProjectId(
              Option.getOrUndefined(cliConfig.projectId),
              Option.getOrUndefined(toml.projectId) ??
                (linkedRef !== undefined && linkedRef !== "" ? linkedRef : undefined),
              workdir,
            ),
          ),
          cwd: workdir,
          npmVersion: Option.getOrUndefined(toml.pgDelta.npmVersion),
          denoVersion: toml.denoVersion,
        };
        yield* legacyTryCacheMigrationsCatalog(fs, path, pgDeltaCtx, {
          enabled: cacheEnabled,
          targetUrl: legacyToPostgresURL(cfg.conn),
          conn: cfg.conn,
          isLocal: false,
          migrationsDir,
        }).pipe(
          Effect.catch((error) =>
            output.raw(
              `Warning: failed to cache migrations catalog: ${redactLegacyConnectionString(error.message)}\n`,
              "stderr",
            ),
          ),
        );
      }),
    );

    if (output.format !== "text") {
      yield* output.success("Reset remote database.", {
        target: "remote",
        version: resolvedVersion,
      });
    }
  });

  yield* body.pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        linkedRefForCache !== undefined && linkedRefForCache !== ""
          ? linkedProjectCache.cache(linkedRefForCache)
          : Effect.void,
      ),
    ),
    Effect.ensuring(telemetryState.flush),
    // Closes the `Scope` `legacyApplyProjectEnv` (above) acquires its `process.env`
    // reverts against — mirrors `push.handler.ts`'s own `body.pipe(..., Effect.scoped)`.
    Effect.scoped,
  );
});
