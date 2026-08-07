import { Effect, FileSystem, Option, Path } from "effect";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyDnsResolverFlag } from "../../../../shared/legacy/global-flags.ts";
import {
  legacyResolveExperimentalWithProjectEnv,
  legacyResolveYesWithProjectEnv,
} from "../../../../shared/legacy/global-flags.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../../../../shared/output/errors.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { legacyAqua, legacyYellow } from "../../../shared/legacy-colors.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { legacyResolveResetSeedConfig } from "../../../shared/db-bootstrap/db-setup.ts";
import { legacyResetLocalDatabase } from "../../../shared/db-bootstrap/reset-local-database.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import {
  legacyCheckDbToml,
  legacyLoadProjectEnv,
} from "../../../shared/legacy-db-config.toml-read.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { legacyApplyMigrations } from "../../../shared/legacy-migration-apply.ts";
import { legacyParseMigrationVersion } from "../../../shared/legacy-migration-timestamp.format.ts";
import { legacyPromptYesNo } from "../../../../shared/legacy/legacy-prompt-yes-no.ts";
import {
  type LegacyDbConnType,
  resolveLegacyDbTargetFlags,
} from "../../../shared/legacy-db-target-flags.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyDropUserSchemas } from "../shared/legacy-drop-schemas.ts";
import { legacyListLocalMigrations } from "../../../shared/legacy-pgdelta.cache.ts";
import { legacyPathMatch } from "../../../shared/legacy-path-match.ts";
import { legacyGetPendingSeeds, legacySeedData } from "../../../shared/legacy-seed-ops.ts";
import { legacyUpsertVaultSecrets } from "../../../shared/legacy-vault.ts";
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
 * (`--linked` / a remote `--db-url`) is native. The local path's container-recreate
 * primitives are ALSO native now — the hidden `db __db-bootstrap` Go seam this used to
 * delegate to (CLI-1325 Stage 3's documented interim) is gone (CLI-1955), and the
 * local-reset composition itself is hoisted into `legacyResetLocalDatabase`
 * (`legacy/shared/db-bootstrap/reset-local-database.ts`, CLI-2062) so `db schema
 * declarative`'s smart-target/sync recovery reset can call it in-process too, instead
 * of shelling out to a second `supabase-go` child. Only the REMOTE target's niche
 * `--experimental` schema-files path with NO resolved version still delegates to the
 * Go binary (`shouldDelegateExperimental`) — the LOCAL target never delegated this at
 * all (the removed seam forwarded `--experimental` straight through to its own Go
 * child), and stays fully native on this path too: `legacyMigrateAndSeed` (reused by
 * both the PG14 and PG15 recreate branches) already implements Go's
 * `apply.MigrateAndSeed` experimental-schema-files branch.
 */
export const legacyDbReset = Effect.fn("legacy.db.reset")(function* (flags: LegacyDbResetFlags) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const dbConn = yield* LegacyDbConnection;
  const proxy = yield* LegacyGoProxy;
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
    // Single source of truth for "does this reset delegate to the Go child?" —
    // checked at both delegation sites below (before `resolve()` for a linked
    // target, after it for a `--db-url` target) so the two call sites can never
    // drift apart.
    const shouldDelegateExperimental = experimental && resolvedVersion === "";

    // Delegates the remaining `--experimental` schema-files apply path
    // (`apply.MigrateAndSeed`, not ported) to the Go child. In text mode inherit
    // its stdio. Under a machine-output mode (`--output-format json|stream-json`)
    // the Go child emits no TS envelope, so suppress its stdout (capture + discard)
    // and emit the same structured success the native local and remote paths do,
    // keeping the JSON contract consistent across all reset paths.
    const delegateExperimentalReset = () =>
      Effect.gen(function* () {
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
      });

    // Go's ParseDatabaseConfig runs LoadProjectRef BEFORE the fallible linked
    // resolution (db_url.go:87-95), and Execute() writes the linked-project cache
    // even when a later step errors (root.go:171-181). Pre-load the ref so the
    // post-run cache finalizer still fires when resolve fails mid-way (merged
    // config, temp-role mint, connection) — mirrors push.handler.
    if (connType === "linked") {
      const refResolver = yield* LegacyProjectRefResolver;
      linkedRefForCache = yield* refResolver.loadProjectRef(Option.none());

      // A linked target is never local (`resolver.resolve()`'s "linked" branch
      // always returns `isLocal: false`), so the delegated-experimental check can
      // run BEFORE calling `resolve()`. This matters: for `connType === "linked"`,
      // `resolve()` mints/verifies a temporary Postgres login role over the
      // Management API — and the delegated Go child re-runs that exact same
      // `ParseDatabaseConfig` work itself once delegation happens. Calling
      // `resolve()` here would mint the temp role twice for zero downstream use on
      // this branch (Go's own reset flow mints it exactly once, as part of the code
      // path being delegated to — confirmed against `apps/cli-go/internal/utils/
      // flags/db_url.go`'s `NewDbConfigWithPassword`/`initLoginRole`). CLI-1879.
      if (shouldDelegateExperimental) {
        yield* delegateExperimentalReset();
        return;
      }
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
    // remote linked path below (a linked+experimental+versionless target already
    // delegated and returned above, before `resolve()` was ever called — see the
    // `connType === "linked"` block earlier in this function). A `connType ===
    // "db-url"` target leaves `linkedRefForCache` as whatever the pre-load block
    // set (nothing, for `db-url`), since this assignment only fires when linked.
    const linkedRef = Option.getOrUndefined(cfg.ref ?? Option.none());
    if (connType === "linked" && linkedRef !== undefined) linkedRefForCache = linkedRef;

    // Remaining remote target: a `--db-url` pointing at a non-local host (the
    // `connType === "linked"` case already delegated above, before `resolve()`,
    // without resolving a connection at all).
    if (shouldDelegateExperimental) {
      yield* delegateExperimentalReset();
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
