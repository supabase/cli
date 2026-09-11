import { Effect, FileSystem, Option, Path } from "effect";

import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { DnsResolverFlag } from "../../../command-internal/global-flags.ts";
import {
  resolveExperimentalWithProjectEnv,
  resolveYesWithProjectEnv,
} from "../../../command-internal/global-flags.ts";
import { promptYesNo } from "../../../command-internal/prompt-yes-no.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../../../shared/output/errors.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { aqua, yellow } from "../../../command-internal/colors.ts";
import { resolveResetSeedConfig } from "../../../command-internal/db-bootstrap/db-setup.ts";
import { resetLocalDatabase } from "../../../command-internal/db-bootstrap/reset-local-database.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import {
  applyProjectEnv,
  checkDbToml,
  loadProjectEnv,
} from "../../../command-internal/db-config.toml-read.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import { applyMigrations, applySchemaFiles } from "../../../command-internal/migration-apply.ts";
import { parseMigrationVersion } from "../../../command-internal/migration-timestamp.format.ts";
import { listLocalMigrations } from "../../../command-internal/migration-list.ts";
import { pathMatch } from "../../../command-internal/path-match.ts";
import { resolveDbTargetFlags } from "../../../command-internal/db-target-flags.ts";
import { getPendingSeeds, seedData } from "../../../command-internal/seed-ops.ts";
import { upsertVaultSecrets } from "../../../command-internal/vault.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { dropUserSchemas } from "../shared/drop-schemas.ts";
import type { DbResetFlags } from "./reset.command.ts";
import {
  DbResetApplyError,
  DbResetCancelledError,
  DbResetInvalidVersionError,
  DbResetLastFlagError,
  DbResetMigrationFileError,
  DbResetSeedFlagsError,
  DbResetTargetFlagsError,
  DbResetVersionFlagsError,
} from "./reset.errors.ts";

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
  const cliArgs = yield* CliArgs;
  const dnsResolver = yield* DnsResolverFlag;

  const workdir = cliSettings.workdir;
  const migrationsDir = path.join(workdir, "supabase", "migrations");
  // The project `.env` is applied before the `yes`/`experimental` gates are read, so a
  // `SUPABASE_YES`/`SUPABASE_EXPERIMENTAL` set only in `supabase/.env` is honored.
  const projectEnv = yield* loadProjectEnv(fs, path, workdir);
  const yes = yield* resolveYesWithProjectEnv(projectEnv);
  const experimental = yield* resolveExperimentalWithProjectEnv(projectEnv);
  let linkedRefForCache: string | undefined;

  const body = Effect.gen(function* () {
    // The project `.env` is applied to make every key visible to the whole reset run, not just
    // the flag-gate reads above — `getRegistryImageUrl` reads `SUPABASE_INTERNAL_IMAGE_REGISTRY`
    // straight from `process.env` for the container image resolution below.
    yield* applyProjectEnv(projectEnv);
    const target = resolveDbTargetFlags(cliArgs.args);
    // Mutually-exclusive db-url/linked/local group.
    if (target.setFlags.length > 1) {
      return yield* Effect.fail(
        new DbResetTargetFlagsError({
          message: `if any flags in the group [db-url linked local] are set none of the others can be; [${target.setFlags.join(" ")}] were all set`,
        }),
      );
    }
    // `--last` is an unsigned flag, so a negative value should be rejected; `Flag.Int` here
    // accepts it, so reject it explicitly rather than silently resetting the full history.
    if (Option.isSome(flags.last) && flags.last.value < 0) {
      return yield* Effect.fail(
        new DbResetLastFlagError({
          message: `invalid argument "${flags.last.value}" for "--last" flag: strconv.ParseUint: parsing "${flags.last.value}": invalid syntax`,
        }),
      );
    }
    // Mutually-exclusive version/last group.
    if (Option.isSome(flags.version) && Option.isSome(flags.last)) {
      return yield* Effect.fail(
        new DbResetVersionFlagsError({
          message:
            "if any flags in the group [last version] are set none of the others can be; [last version] were all set",
        }),
      );
    }

    // `--no-seed` conflicts with `--sql-paths`, and each `--sql-paths` value
    // must be non-empty.
    if (flags.noSeed && flags.sqlPaths.length > 0) {
      return yield* Effect.fail(
        new DbResetSeedFlagsError({
          message: "--no-seed cannot be used with --sql-paths",
          suggestion: `Use either ${aqua("--no-seed")} to skip seeding or ${aqua(
            "--sql-paths",
          )} to override seed files, not both.`,
        }),
      );
    }
    if (flags.sqlPaths.some((p) => p.length === 0)) {
      return yield* Effect.fail(
        new DbResetSeedFlagsError({
          message: "--sql-paths requires a non-empty path or glob pattern",
          suggestion: `Pass a non-empty file path or glob pattern to ${aqua("--sql-paths")}.`,
        }),
      );
    }
    // A remote target flag + --sql-paths warns about the seed override.
    if (
      flags.sqlPaths.length > 0 &&
      (target.setFlags.includes("linked") || target.setFlags.includes("db-url"))
    ) {
      yield* output.raw(
        `${yellow("WARNING:")} --sql-paths overrides [db.seed].sql_paths and seeds the remote database selected by --linked or --db-url.\n`,
        "stderr",
      );
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
        return yield* Effect.fail(
          new DbResetInvalidVersionError({
            message: "invalid version number",
          }),
        );
      }
      // Validated by globbing `supabase/migrations/<version>_*.sql` directly, with no filtering,
      // so a deprecated first migration that `listLocalMigrations` excludes is still accepted.
      const entries = yield* fs
        .readDirectory(migrationsDir)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      const found = entries.some((name) => pathMatch(`${v}_*.sql`, path.basename(name)).matched);
      if (!found) {
        return yield* Effect.fail(
          new DbResetMigrationFileError({
            message: `glob supabase/migrations/${v}_*.sql: file does not exist`,
          }),
        );
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
      resolvedVersion = last < total ? versions[total - last - 1]! : "-";
    }

    const connType = target.connType ?? "local";

    // `--project-ref` only applies to the linked target; it must not be silently ignored when
    // targeting `--local`/`--db-url`.
    if (Option.isSome(flags.projectRef) && connType !== "linked") {
      return yield* Effect.fail(
        new DbResetTargetFlagsError({
          message:
            "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
        }),
      );
    }

    // Loaded before the fallible linked resolution, so the post-run cache finalizer still fires
    // even when `resolver.resolve` fails mid-way (merged config, temp-role mint, connection).
    if (connType === "linked") {
      const refResolver = yield* ProjectRefResolver;
      linkedRefForCache = yield* refResolver.loadProjectRef(flags.projectRef);
    }

    const cfg = yield* resolver.resolve({
      dbUrl: flags.dbUrl,
      connType,
      dnsResolver,
      linkedProjectRef: flags.projectRef,
    });

    // Local target: the composition (container recreate, storage-health gate, bucket seeding,
    // git-branch line) is hoisted into `resetLocalDatabase`, shared with `db schema declarative`'s
    // recovery reset; this call site keeps only version/seed-flags plumbing and the JSON envelope.
    if (cfg.isLocal) {
      yield* resetLocalDatabase({
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

    // Re-confirms `linkedRefForCache` from the now-resolved `cfg.ref`; a `db-url` target leaves
    // it as whatever the pre-load block set (nothing), since this only fires when linked.
    const linkedRef = Option.getOrUndefined(cfg.ref ?? Option.none());
    if (connType === "linked" && linkedRef !== undefined) linkedRefForCache = linkedRef;

    // Decodes the whole config with env-expansion and weak-typed boolean parsing, applies
    // `SUPABASE_*` overrides, merges a matching `[remotes.<ref>]` block, and decrypts every
    // `encrypted:` secret — aborting here, before the destructive prompt, on any invalid config.
    const configRef = connType === "linked" && linkedRef !== undefined ? linkedRef : undefined;
    const toml = yield* checkDbToml(fs, path, workdir, configRef);
    if (toml.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${toml.appliedRemote}]\n`, "stderr");
    }
    const vaultSecrets = toml.vault;

    // Prompt (default false) → cancel, then reset everything.
    const shouldReset = yield* promptYesNo(
      output,
      yes,
      "Do you want to reset the remote database?",
      false,
    );
    if (!shouldReset) {
      return yield* Effect.fail(new DbResetCancelledError({ message: CONTEXT_CANCELED_MESSAGE }));
    }
    yield* output.raw(`Resetting remote database${toLogMessage(resolvedVersion)}\n`, "stderr");

    // Established output contract: no "Connecting to ... database..." line is printed here.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* dbConn.connect(cfg.conn, { isLocal: false, dnsResolver });
        // Reset everything: drop user schemas → upsert vault → migrate + seed.
        yield* dropUserSchemas(session, applyError);
        yield* upsertVaultSecrets(session, vaultSecrets);

        // Takes the schema-files branch when `--experimental`/`SUPABASE_EXPERIMENTAL` is set, no
        // version is resolved, and pg-delta is disabled — a hard if/else-if, so an empty
        // `schema_paths = []` applies nothing rather than falling back to migrations.
        const useSchemaFiles = experimental && resolvedVersion === "" && !toml.pgDelta.enabled;
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
          yield* applyMigrations(session, fs, path, pending, applyError);
        }

        // `--no-seed` disables seeding; `--sql-paths` overrides `[db.seed].sql_paths` and
        // force-enables it (mutually exclusive, validated above). Shares `resolveResetSeedConfig`
        // with the local path's identical override.
        const resolvedSeed = resolveResetSeedConfig(
          toml.seed,
          { noSeed: flags.noSeed, sqlPaths: flags.sqlPaths },
          path,
        );
        if (resolvedSeed.enabled) {
          const seeds = yield* getPendingSeeds(session, fs, path, resolvedSeed.sqlPaths, workdir);
          yield* seedData(session, fs, workdir, path, seeds, applyError);
        }
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
    // Closes the `Scope` that `applyProjectEnv` acquires its `process.env` revert against.
    Effect.scoped,
  );
});
