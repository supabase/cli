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
 * `supabase db reset` — reinitialise a database from local migrations (+ seed).
 *
 * Fully native — no remaining Go delegation on either target. The local
 * path's container-recreate primitives are native, and the local-reset
 * composition itself is hoisted into `resetLocalDatabase`
 * (`command-internal/db-bootstrap/reset-local-database.ts`) so `db schema
 * declarative`'s smart-target/sync recovery reset can call it in-process too,
 * instead of shelling out to a second `supabase-go` child. The remote target's
 * `--experimental` schema-files path — the last remaining Go delegation on
 * this command — is now also native (`applySchemaFiles`): a versionless
 * `--experimental`/`SUPABASE_EXPERIMENTAL` remote reset with pg-delta NOT
 * enabled takes the EXPERIMENTAL declarative schema-files branch instead of
 * replaying timestamped migrations, mirroring `migrateAndSeed`'s
 * already-native local-side implementation of the exact same branch (reused
 * by both the PG14 and PG15 recreate paths).
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
  // The project `.env` is applied before the `yes`/`experimental` gates are
  // read, so a `SUPABASE_YES` / `SUPABASE_EXPERIMENTAL` set only in
  // `supabase/.env` is honored. Load the project env first and resolve both
  // gates against it, as `db pull` does for `yes`.
  const projectEnv = yield* loadProjectEnv(fs, path, workdir);
  const yes = yield* resolveYesWithProjectEnv(projectEnv);
  const experimental = yield* resolveExperimentalWithProjectEnv(projectEnv);
  let linkedRefForCache: string | undefined;

  const body = Effect.gen(function* () {
    // The project `.env` is applied to make every key visible to the WHOLE
    // reset run, not just the flag-gate reads above — in particular
    // `getRegistryImageUrl` reads
    // `SUPABASE_INTERNAL_IMAGE_REGISTRY` straight from
    // `process.env` for the container image resolution below (review CLI-1958). `db push`
    // (`push.handler.ts`) scopes this the same way, as the first statement of its own
    // `body` — mirror that exactly so a private/air-gapped registry configured only in
    // `supabase/.env` reaches image resolution instead of silently falling back to the
    // default registries.
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
    // `--last` is an unsigned flag, so a negative value is rejected at parse
    // time (`Flag.integer` here accepts it). Reject it the same way rather
    // than silently treating it as "no --last" and resetting the full history.
    if (Option.isSome(flags.last) && flags.last.value < 0) {
      return yield* Effect.fail(
        new DbResetLastFlagError({
          message: `invalid argument "${flags.last.value}" for "--last" flag: strconv.ParseUint: parsing "${flags.last.value}": invalid syntax`,
        }),
      );
    }
    // Mutually-exclusive version/last group — alphabetical group.
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
      // Rejects non-numeric text AND values outside the int64 range;
      // `parseMigrationVersion` mirrors that exactly (`migration repair`
      // uses the same helper for its own version parse).
      if (parseMigrationVersion(v) === undefined) {
        // The bare "invalid version number" is returned unwrapped; the
        // `failed to parse <v>:` wrapper belongs to `migration repair` only.
        return yield* Effect.fail(
          new DbResetInvalidVersionError({
            message: "invalid version number",
          }),
        );
      }
      // The version is validated by globbing `supabase/migrations/<version>_*.sql`
      // DIRECTLY with no filtering — so a deprecated first migration (e.g.
      // `20200101000000_init.sql`) that `listLocalMigrations` excludes is
      // still accepted. Mirror that with a raw directory read + glob match
      // instead of the filtered migration listing.
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

    // `--project-ref` never implies `--linked` and must not be silently
    // discarded on a non-linked target — see push.handler.ts's identical guard
    // for the full TS-only rationale.
    if (Option.isSome(flags.projectRef) && connType !== "linked") {
      return yield* Effect.fail(
        new DbResetTargetFlagsError({
          message:
            "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
        }),
      );
    }

    // The project ref is loaded BEFORE the fallible linked resolution, and
    // the linked-project cache is written even when a later step errors.
    // Pre-load the ref so the post-run cache finalizer still fires when
    // resolve fails mid-way (merged config, temp-role mint, connection) —
    // mirrors push.handler.
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

    // Local target → native local reset. The actual composition (running
    // check, container recreate, storage-health gate, bucket seeding,
    // git-branch line) is hoisted into `resetLocalDatabase` — shared
    // with `db schema declarative`'s in-process recovery reset — so this
    // call site stays a thin wrapper around it, keeping only the version/
    // seed-flags plumbing and the JSON envelope, which belong to this
    // top-level command alone (see that function's own header for why).
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

    // Re-confirm `linkedRefForCache` from the now-resolved `cfg.ref` for the native
    // remote path below. A `connType === "db-url"` target leaves `linkedRefForCache`
    // as whatever the pre-load block set (nothing, for `db-url`), since this
    // assignment only fires when linked.
    const linkedRef = Option.getOrUndefined(cfg.ref ?? Option.none());
    if (connType === "linked" && linkedRef !== undefined) linkedRefForCache = linkedRef;

    // Single config load: decodes the whole config with env-expansion +
    // weak-typed boolean parsing (so `enabled = "env(SEED_ENABLED)"` etc.
    // load), applies `SUPABASE_*` env overrides, merges a matching
    // `[remotes.<ref>]` block, and decrypts every `encrypted:` secret with
    // the shell AND project-`.env` `DOTENV_PRIVATE_KEY*` keys — aborting here
    // (before the destructive prompt / `dropUserSchemas`) on any
    // undecryptable/invalid config, exactly like the established behavior
    // before the reset runs.
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

    // Established output contract: NO "Connecting to ... database..." line
    // is printed here.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* dbConn.connect(cfg.conn, { isLocal: false, dnsResolver });
        // Reset everything: drop user schemas → upsert vault → migrate + seed.
        yield* dropUserSchemas(session, applyError);
        yield* upsertVaultSecrets(session, vaultSecrets);

        // Three-conjunct EXPERIMENTAL gate: `--experimental`/`SUPABASE_EXPERIMENTAL`
        // + no resolved version + pg-delta NOT enabled. A hard if/else-if —
        // taking the schema-files branch means timestamped migrations never
        // run at all, even when the glob matches nothing (an empty
        // `schema_paths = []` default silently applies NOTHING rather than
        // falling back to migrations — CLI-1958).
        const useSchemaFiles = experimental && resolvedVersion === "" && !toml.pgDelta.enabled;
        if (useSchemaFiles) {
          // `projectEnv` (loaded above, before `experimental`/`yes` resolve) is
          // threaded through so a `SUPABASE_SCANNER_BUFFER_SIZE` set only in
          // `supabase/.env` is honored here (see `checkScannerBufferSize`'s
          // doc comment, `migration-apply.ts`).
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
          // LoadPartialMigrations filter: version === "" || v <= version.
          const pending = locals.filter((p) => {
            if (resolvedVersion === "") return true;
            const m = MIGRATE_FILE_PATTERN.exec(path.basename(p));
            return m?.[1] !== undefined && m[1] <= resolvedVersion;
          });
          yield* applyMigrations(session, fs, path, pending, applyError);
        }

        // `--no-seed` disables seeding; `--sql-paths` overrides [db.seed].sql_paths
        // and force-enables it. The two are mutually exclusive (validated
        // above). Same single home as the local path's identical override
        // (`resolveResetSeedConfig`, `db-setup.ts`) — one implementation
        // of this seed-flags override for both targets, per "Hoist Before You
        // Duplicate" (`apps/cli/CLAUDE.md`).
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
    // Closes the `Scope` `applyProjectEnv` (above) acquires its `process.env`
    // reverts against — mirrors `push.handler.ts`'s own `body.pipe(..., Effect.scoped)`.
    Effect.scoped,
  );
});
