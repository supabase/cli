import { Effect, FileSystem, Option, Path } from "effect";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { detectGitBranch } from "../../../../shared/git/git-branch.ts";
import { LegacyDnsResolverFlag } from "../../../../shared/legacy/global-flags.ts";
import {
  legacyResolveExperimentalWithProjectEnv,
  legacyResolveYesWithProjectEnv,
} from "../../../../shared/legacy/global-flags.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { legacyAqua, legacyYellow } from "../../../shared/legacy-colors.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import {
  legacyCheckDbToml,
  legacyLoadProjectEnv,
  legacyResolveSeedSqlPath,
} from "../../../shared/legacy-db-config.toml-read.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { legacyApplyMigrations } from "../../../shared/legacy-migration-apply.ts";
import { legacyPromptYesNo } from "../../../shared/legacy-prompt-yes-no.ts";
import {
  type LegacyDbConnType,
  resolveLegacyDbTargetFlags,
} from "../../../shared/legacy-db-target-flags.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyDropUserSchemas } from "../shared/legacy-drop-schemas.ts";
import { LegacyDbBootstrapSeam } from "../shared/legacy-db-bootstrap.seam.service.ts";
import { legacyListLocalMigrations } from "../shared/legacy-pgdelta.cache.ts";
import {
  legacyGetPendingSeeds,
  legacyMatchPattern,
  legacySeedData,
} from "../shared/legacy-seed-ops.ts";
import { legacyUpsertVaultSecrets } from "../../../shared/legacy-vault.ts";
import { legacySeedBucketsRun } from "../../../shared/legacy-seed-buckets.ts";
import type { LegacyDbResetFlags } from "./reset.command.ts";
import {
  LegacyDbResetApplyError,
  LegacyDbResetCancelledError,
  LegacyDbResetInvalidVersionError,
  LegacyDbResetLastFlagError,
  LegacyDbResetMigrationFileError,
  LegacyDbResetNotRunningError,
  LegacyDbResetSeedFlagsError,
  LegacyDbResetTargetFlagsError,
  LegacyDbResetVersionFlagsError,
} from "./reset.errors.ts";

const INTEGER_PATTERN = /^[+-]?\d+$/u;
const MIGRATE_FILE_PATTERN = /^([0-9]+)_(.*)\.sql$/u;

const applyError = (message: string) => new LegacyDbResetApplyError({ message });

/** Go's `toLogMessage` (`internal/db/reset/reset.go:88-91`). */
const toLogMessage = (version: string): string =>
  version.length > 0 ? ` to version: ${version}` : "...";

/**
 * Rebuilds the `db reset` argv for the remaining Go-delegated path: a remote
 * `--experimental` reset with no resolved version. Only the flags reachable on
 * that path are forwarded — `--local` always takes the native path, and a set
 * `--version`/`--last` resolves a non-empty version which disables the experimental
 * delegation (a degenerate `--last 0` resolves to "" and is behaviourally identical
 * whether or not it is forwarded, so it is omitted).
 *
 * The target selector is forwarded from the RESOLVED `connType`, not the raw `--linked`
 * boolean: the parent's `resolveLegacyDbTargetFlags` follows Cobra's `Changed` semantics, so
 * `--linked=false` selects the linked/remote target (this path is remote-only). Forwarding
 * only when `flags.linked === true` would drop the selector for `--linked=false` and let the
 * Go child fall back to its local default — resetting the wrong database.
 */
const buildResetArgs = (
  flags: LegacyDbResetFlags,
  connType: LegacyDbConnType,
  yes: boolean,
): Array<string> => {
  const args = ["db", "reset"];
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  else if (connType === "linked") args.push("--linked");
  if (flags.noSeed) args.push("--no-seed");
  for (const p of flags.sqlPaths) args.push("--sql-paths", p);
  // Forward the parent's RESOLVED `yes` as a bound flag. Go's `--yes` beats `AutomaticEnv`,
  // so `--yes=false` overrides an inherited `SUPABASE_YES=true` (the child no longer
  // auto-confirms a reset the user protected with `--yes=false`), while `--yes=true` honors
  // an explicit `--yes` / env even in machine mode where the child's stdin is ignored.
  // `--yes=false` still prompts on a TTY (Go's PromptYesNo only short-circuits on true), so
  // this matches the default behavior when neither flag nor env is set.
  args.push(`--yes=${yes}`);
  return args;
};

/**
 * `supabase db reset` — reinitialise a database from local migrations (+ seed).
 *
 * Strict 1:1 port of `apps/cli-go/internal/db/reset/reset.go`. The remote path
 * (`--linked` / a remote `--db-url`) is native. The local path (and the niche
 * `--experimental` schema-files path) delegate to the Go binary as a documented
 * interim until the container-bootstrap seam is ported (CLI-1325 Stage 3).
 */
export const legacyDbReset = Effect.fn("legacy.db.reset")(function* (flags: LegacyDbResetFlags) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const dbConn = yield* LegacyDbConnection;
  const proxy = yield* LegacyGoProxy;
  const seam = yield* LegacyDbBootstrapSeam;
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
    if (Option.isSome(flags.version)) {
      const v = flags.version.value;
      if (!INTEGER_PATTERN.test(v)) {
        return yield* Effect.fail(
          new LegacyDbResetInvalidVersionError({
            message: `failed to parse ${v}: invalid version number`,
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
      const found = entries.some((name) => legacyMatchPattern(`${v}_*.sql`, path.basename(name)));
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

    // Local target → native local reset. The container-recreate primitives live
    // behind the hidden Go `db __db-bootstrap` seam; TS orchestrates the rest
    // (running check, messages, bucket seeding, git-branch line, output shaping).
    // Mirrors `internal/db/reset/reset.go:57-77`.
    if (cfg.isLocal) {
      // Go's `flags.LoadConfig` (root `PersistentPreRunE` → the local target's
      // per-connType `LoadConfig`, `internal/utils/flags/db_url.go:77-80`) runs full
      // config validation before `reset.Run` ever reaches `AssertSupabaseDbIsRunning`
      // / the destructive `resetDatabase` (`internal/db/reset/reset.go:57-61`). The
      // resolver's own local read (above, line 239) already performs the identical
      // validation and would already reject a broken config before this point is
      // reached — so today this re-validates for its own sake. Repeat it here anyway,
      // as an explicit, independent gate (the same pattern `db start` and `db push`
      // use), so the "malformed config aborts before the local database is recreated"
      // guarantee is enforced by this handler directly and stays covered by a
      // handler-level test even if the resolver's own internal read is ever mocked,
      // relaxed, or refactored to stop validating.
      yield* legacyCheckDbToml(fs, path, workdir);

      // AssertSupabaseDbIsRunning — error if the local db container is down.
      const running = yield* seam.isDbRunning();
      if (!running) {
        return yield* Effect.fail(
          new LegacyDbResetNotRunningError({
            message: `${legacyAqua("supabase start")} is not running.`,
          }),
        );
      }
      // resetDatabase: "Resetting local database…" then recreate + migrate + seed.
      yield* output.raw(`Resetting local database${toLogMessage(resolvedVersion)}\n`, "stderr");
      yield* seam.recreateDatabase({
        version: resolvedVersion,
        noSeed: flags.noSeed,
        sqlPaths: flags.sqlPaths,
      });

      // Seed objects from supabase/buckets when storage is up (Go gates buckets on
      // an existing, healthy storage container). Reuses the ported seed-buckets
      // local path; its summary is suppressed (reset emits its own result).
      const storageReady = yield* seam.awaitStorageReady();
      if (storageReady) {
        // Go's `buckets.Run(ctx, "", false, fsys)` — non-interactive: overwrite/prune
        // confirmations take their defaults instead of blocking on input.
        //
        // `legacyCheckDbToml` above resolves `env(VAR)` via `legacyLoadProjectEnv`,
        // which mirrors Go's full nested-env walk (`.env.<SUPABASE_ENV>.local`,
        // `.env.local`, `.env.<SUPABASE_ENV>`, `.env`, across both `supabase/` and the
        // project root — `pkg/config/config.go:1220-1257`). This reload instead goes
        // through `@supabase/config`'s `loadProjectConfig` → `loadProjectEnvironment`,
        // which only ever reads `supabase/.env`/`.env.local` plus ambient env
        // (`packages/config/src/project.ts:209-245`) — regardless of `goViperCompat`,
        // which only widens `env(VAR)` matching, not the file set consulted. So a
        // config whose `env(VAR)` reference is backed by e.g. `supabase/.env.development`
        // is genuinely Go-valid (Go's `godotenv.Load` calls `os.Setenv`, so the value is
        // real ambient env by the time Go resolves it — `config.go:1260-1261`) and
        // already passed `legacyCheckDbToml` and the real recreate above, but this
        // narrower reload can still reject it. A `LegacySeedConfigLoadError` here is
        // that env-file-set gap, not a genuinely invalid config — and recreate already
        // dropped/rebuilt the DB, so aborting now would leave the reset half-done; warn
        // and skip buckets so `db reset` finishes like Go instead.
        yield* legacySeedBucketsRun({
          projectRef: "",
          emitSummary: false,
          interactive: false,
          // Go loads nested env before `buckets.Run`, so `SUPABASE_YES` in `supabase/.env`
          // auto-confirms bucket/vector/analytics prune prompts. Pass the project-env-resolved
          // `yes` (the shared runner's own `legacyResolveYes` only sees the shell env).
          yes,
        }).pipe(
          Effect.catchTag("LegacySeedConfigLoadError", (error) =>
            output.raw(
              `${legacyYellow("WARNING:")} skipped seeding storage buckets: ${error.message}\n`,
              "stderr",
            ),
          ),
        );
      }

      // "Finished supabase db reset on branch <branch>." (both Aqua).
      const branch = Option.getOrElse(yield* detectGitBranch(workdir), () => "main");
      yield* output.raw(
        `Finished ${legacyAqua("supabase db reset")} on branch ${legacyAqua(branch)}.\n`,
        "stderr",
      );
      if (output.format !== "text") {
        yield* output.success("Reset local database.", {
          target: "local",
          version: resolvedVersion,
        });
      }
      return;
    }

    // Resolve the linked ref before any return so the post-run cache (Go's
    // `PersistentPostRun` `ensureProjectGroupsCached`) is written even on the
    // delegated `--experimental` path below — the Go child runs with telemetry
    // disabled and skips that cache, so the TS finalizer must own it.
    const linkedRef = Option.getOrUndefined(cfg.ref ?? Option.none());
    if (connType === "linked" && linkedRef !== undefined) linkedRefForCache = linkedRef;

    // Remote path. The niche `--experimental` schema-files apply path
    // (`apply.MigrateAndSeed`) is not ported; delegate it to the Go child. In text
    // mode inherit its stdio. Under a machine-output mode (`--output-format
    // json|stream-json`) the Go child emits no TS envelope, so suppress its stdout
    // (capture + discard) and emit the same structured success the native local and
    // remote paths do, keeping the JSON contract consistent across all reset paths.
    if (experimental && resolvedVersion === "") {
      const env = { SUPABASE_TELEMETRY_DISABLED: "1" };
      if (output.format === "text") {
        yield* proxy.exec(buildResetArgs(flags, connType, yes), { env });
      } else {
        // Machine-output mode is non-interactive: give the Go child a non-TTY stdin
        // (`stdin: "ignore"`) so it can't block on (or be answered at) Go's
        // destructive reset prompt — it takes the default `false`, matching the
        // native reset path which suppresses prompts under json/stream-json.
        yield* proxy.execCapture(buildResetArgs(flags, connType, yes), { env, stdin: "ignore" });
        yield* output.success("Reset remote database.", {
          target: "remote",
          version: resolvedVersion,
        });
      }
      return;
    }

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
      return yield* Effect.fail(new LegacyDbResetCancelledError({ message: "context canceled" }));
    }
    yield* output.raw(`Resetting remote database${toLogMessage(resolvedVersion)}\n`, "stderr");

    // Go connects with io.Discard, so NO "Connecting to ... database..." line.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* dbConn.connect(cfg.conn, { isLocal: false, dnsResolver });
        // ResetAll: drop user schemas → upsert vault → migrate + seed.
        yield* legacyDropUserSchemas(session, applyError);
        yield* legacyUpsertVaultSecrets(session, vaultSecrets);

        if (toml.migrationsEnabled) {
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
        // exclusive (validated above).
        const overrideSeed = flags.sqlPaths.length > 0;
        // `--sql-paths` force-enables seeding (Go's applyDbResetSeedFlags); otherwise
        // honor `db.seed.enabled` (already `SUPABASE_DB_SEED_ENABLED`-resolved by the reader).
        const seedEnabled = overrideSeed || (toml.seed.enabled && !flags.noSeed);
        if (seedEnabled) {
          // `[db.seed].sql_paths` is already Go-config-resolved (supabase/-joined) by the
          // reader; the `--sql-paths` override is resolved here the same way Go's
          // `resolveSeedSqlPaths` does, so both feed the glob identical paths.
          const seedPaths = overrideSeed
            ? flags.sqlPaths.map((p) => legacyResolveSeedSqlPath(path, p))
            : toml.seed.sqlPaths;
          const seeds = yield* legacyGetPendingSeeds(session, fs, path, seedPaths, workdir);
          yield* legacySeedData(session, fs, workdir, path, seeds, applyError);
        }
        // Go's best-effort pgcache catalog warning is not ported (no output impact).
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
  );
});
