import { Effect, FileSystem, Option, Path } from "effect";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyDnsResolverFlag } from "../../../../shared/legacy/global-flags.ts";
import { legacyResolveYesWithProjectEnv } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { legacyAqua, legacyBold } from "../../../shared/legacy-colors.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import {
  legacyCheckDbToml,
  legacyLoadProjectEnv,
} from "../../../shared/legacy-db-config.toml-read.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import {
  legacyApplyMigrations,
  legacySeedGlobals,
} from "../../../shared/legacy-migration-apply.ts";
import { legacyPromptYesNo } from "../../../shared/legacy-prompt-yes-no.ts";
import { resolveLegacyDbTargetFlags } from "../../../shared/legacy-db-target-flags.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyListLocalMigrations } from "../shared/legacy-pgdelta.cache.ts";
import {
  LEGACY_ERR_MISSING_LOCAL,
  LEGACY_ERR_MISSING_REMOTE,
  legacyFindPendingMigrations,
  legacyIncludeAllPending,
  legacySuggestIgnoreFlag,
  legacySuggestRevertHistory,
} from "../shared/legacy-migration-pending.ts";
import {
  type LegacySeedFile,
  legacyGetPendingSeeds,
  legacySeedData,
} from "../shared/legacy-seed-ops.ts";
import { legacyUpsertVaultSecrets } from "../../../shared/legacy-vault.ts";
// Listing the remote `schema_migrations` history (with the 42P01 → empty rule)
// lives in the shared migration-history module (Go's `migration.ListRemoteMigrations`).
import { legacyListRemoteMigrations } from "../../../shared/legacy-migration-history.ts";
import type { LegacyDbPushFlags } from "./push.command.ts";
import {
  LegacyDbPushApplyError,
  LegacyDbPushCancelledError,
  LegacyDbPushMissingLocalError,
  LegacyDbPushMissingRemoteError,
  LegacyDbPushRolesError,
  LegacyDbPushTargetFlagsError,
} from "./push.errors.ts";

const CUSTOM_ROLES_PATH = "supabase/roles.sql";

const toSlash = (p: string): string => p.replaceAll("\\", "/");

/** Go's `confirmPushAll` (`internal/db/push/push.go:123-129`) — bold filenames. */
const confirmPushAll = (filenames: ReadonlyArray<string>): string =>
  filenames.map((name) => ` • ${legacyBold(name)}\n`).join("");

/** Go's `confirmSeedAll` (`internal/db/push/push.go:131-140`) — bold paths, hash notice. */
const confirmSeedAll = (seeds: ReadonlyArray<LegacySeedFile>): string =>
  seeds
    .map((seed) => ` • ${legacyBold(seed.dirty ? `${seed.path} (hash update)` : seed.path)}\n`)
    .join("");

const applyError = (message: string) => new LegacyDbPushApplyError({ message });

/**
 * `supabase db push` — apply pending local migrations (and optionally seed data
 * and custom roles) to the local or linked/remote database.
 *
 * Strict 1:1 port of `apps/cli-go/internal/db/push/push.go`.
 */
export const legacyDbPush = Effect.fn("legacy.db.push")(function* (flags: LegacyDbPushFlags) {
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
  // Go's `ParseDatabaseConfig` runs `loadNestedEnv` (which `os.Setenv`s each project-`.env`
  // key) before `PromptYesNo` reads `viper.GetBool("YES")`, so a `SUPABASE_YES` set only in
  // `supabase/.env` auto-confirms. Resolve `yes` with that project env, as `db pull` does.
  const projectEnv = yield* legacyLoadProjectEnv(fs, path, workdir);
  const yes = yield* legacyResolveYesWithProjectEnv(projectEnv);
  let linkedRefForCache: string | undefined;

  const body = Effect.gen(function* () {
    const target = resolveLegacyDbTargetFlags(cliArgs.args);
    // cobra MarkFlagsMutuallyExclusive("db-url", "linked", "local"), keyed off the
    // explicitly-set flags (cobra's `Changed`), not the `--linked` default value.
    if (target.setFlags.length > 1) {
      return yield* Effect.fail(
        new LegacyDbPushTargetFlagsError({
          message: `if any flags in the group [db-url linked local] are set none of the others can be; [${target.setFlags.join(" ")}] were all set`,
        }),
      );
    }
    // Go's push defaults `--linked` to true, so no target flag → linked.
    const connType = target.connType ?? "linked";

    // The linked path resolves the project ref before loading config so a matching
    // `[remotes.<ref>]` block merges (Go's ParseDatabaseConfig → LoadConfig). For
    // `--local` / `--db-url`, Go leaves `flags.ProjectRef` empty.
    let projectRef = "";
    if (connType === "linked") {
      const refResolver = yield* LegacyProjectRefResolver;
      projectRef = yield* refResolver.loadProjectRef(Option.none());
      linkedRefForCache = projectRef;
    }

    // Single Go-parity config load (`flags.LoadConfig` → `config.Load` + `Validate`):
    // decodes the whole config with Go's env-expansion + `strconv.ParseBool` weak typing
    // (so `enabled = "env(SEED_ENABLED)"` etc. load like Go), applies `SUPABASE_*`
    // AutomaticEnv overrides, merges a matching `[remotes.<ref>]` block, and decrypts every
    // `encrypted:` secret with the shell AND project-`.env` `DOTENV_PRIVATE_KEY*` keys —
    // aborting here (before connecting or writing) on any undecryptable/invalid config.
    const toml = yield* legacyCheckDbToml(
      fs,
      path,
      workdir,
      projectRef !== "" ? projectRef : undefined,
    );
    if (toml.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${toml.appliedRemote}]\n`, "stderr");
    }
    const vaultSecrets = toml.vault;

    if (flags.dryRun) {
      yield* output.raw("DRY RUN: migrations will *not* be pushed to the database.\n", "stderr");
    }

    const cfg = yield* resolver.resolve({
      dbUrl: flags.dbUrl,
      connType,
      dnsResolver,
      password: flags.password,
    });
    const databaseName = cfg.isLocal ? "local database" : "remote database";
    const statusTarget = cfg.isLocal ? "Local database" : "Remote database";

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* output.raw(
          `Connecting to ${cfg.isLocal ? "local" : "remote"} database...\n`,
          "stderr",
        );
        const session = yield* dbConn.connect(cfg.conn, { isLocal: cfg.isLocal, dnsResolver });

        // --- Collect pending migrations ---
        let pending: ReadonlyArray<string> = [];
        if (!toml.migrationsEnabled) {
          yield* output.raw(
            `Skipping migrations because it is disabled in config.toml for project: ${projectRef}\n`,
            "stderr",
          );
        } else {
          const migrationsDir = path.join(workdir, "supabase", "migrations");
          const remote = yield* legacyListRemoteMigrations(session);
          const local = yield* legacyListLocalMigrations(fs, path, migrationsDir);
          const result = legacyFindPendingMigrations(local, remote);
          if (result.kind === "missing-local") {
            return yield* Effect.fail(
              new LegacyDbPushMissingLocalError({
                message: LEGACY_ERR_MISSING_LOCAL,
                suggestion: legacySuggestRevertHistory(result.versions),
              }),
            );
          }
          if (result.kind === "missing-remote") {
            if (!flags.includeAll) {
              // Go's suggestIgnoreFlag lists the workdir-relative paths.
              const relPaths = result.paths.map((p) => toSlash(path.relative(workdir, p)));
              return yield* Effect.fail(
                new LegacyDbPushMissingRemoteError({
                  message: LEGACY_ERR_MISSING_REMOTE,
                  suggestion: legacySuggestIgnoreFlag(relPaths),
                }),
              );
            }
            pending = legacyIncludeAllPending(local, remote.length, result.paths);
          } else {
            pending = result.pending;
          }
        }

        // --- Collect pending seeds ---
        let seeds: ReadonlyArray<LegacySeedFile> = [];
        if (flags.includeSeed) {
          if (!toml.seed.enabled) {
            yield* output.raw(
              `Skipping seed because it is disabled in config.toml for project: ${projectRef}\n`,
              "stderr",
            );
          } else {
            seeds = yield* legacyGetPendingSeeds(session, fs, path, toml.seed.sqlPaths, workdir);
          }
        }

        // --- Collect custom roles ---
        const globals: Array<string> = [];
        if (flags.includeRoles) {
          const exists = yield* fs.exists(path.join(workdir, CUSTOM_ROLES_PATH)).pipe(
            Effect.mapError(
              (cause) =>
                new LegacyDbPushRolesError({
                  message: `failed to find custom roles: ${cause.message}`,
                }),
            ),
          );
          if (exists) globals.push(CUSTOM_ROLES_PATH);
        }

        // --- Nothing to push ---
        if (pending.length === 0 && seeds.length === 0 && globals.length === 0) {
          if (output.format === "text") {
            yield* output.raw(`${statusTarget} is up to date.\n`);
          } else {
            yield* output.success(`${statusTarget} is up to date.`, {
              upToDate: true,
              dryRun: flags.dryRun,
              migrations: [],
              seeds: [],
              roles: [],
            });
          }
          return;
        }

        if (flags.dryRun) {
          if (globals.length > 0) {
            yield* output.raw(
              `Would create custom roles ${legacyBold(globals[0]!)}...\n`,
              "stderr",
            );
          }
          if (pending.length > 0) {
            yield* output.raw("Would push these migrations:\n", "stderr");
            yield* output.raw(confirmPushAll(pending.map((p) => path.basename(p))), "stderr");
          }
          if (seeds.length > 0) {
            yield* output.raw("Would seed these files:\n", "stderr");
            yield* output.raw(confirmSeedAll(seeds), "stderr");
          }
        } else {
          // --- Custom roles ---
          if (globals.length > 0) {
            const ok = yield* legacyPromptYesNo(
              output,
              yes,
              "Do you want to create custom roles in the database cluster?",
              true,
            );
            if (!ok) {
              return yield* Effect.fail(
                new LegacyDbPushCancelledError({ message: "context canceled" }),
              );
            }
            yield* legacySeedGlobals(
              session,
              fs,
              path,
              globals.map((g) => path.join(workdir, g)),
              applyError,
            );
          }

          // --- Migrations ---
          if (pending.length > 0) {
            const ok = yield* legacyPromptYesNo(
              output,
              yes,
              `Do you want to push these migrations to the ${databaseName}?\n${confirmPushAll(pending.map((p) => path.basename(p)))}`,
              true,
            );
            if (!ok) {
              return yield* Effect.fail(
                new LegacyDbPushCancelledError({ message: "context canceled" }),
              );
            }
            yield* legacyUpsertVaultSecrets(session, vaultSecrets);
            yield* legacyApplyMigrations(session, fs, path, pending, applyError);
            // Go best-effort caches the migrations catalog for pg-delta; a failure
            // only warns (`push.go:99-101`). The catalog cache is not yet ported, so
            // there is nothing to warn about — parity is preserved (no extra output).
          } else {
            yield* output.raw("Schema migrations are up to date.\n", "stderr");
          }

          // --- Seeds ---
          if (seeds.length > 0) {
            const ok = yield* legacyPromptYesNo(
              output,
              yes,
              `Do you want to seed the ${databaseName} with these files?\n${confirmSeedAll(seeds)}`,
              true,
            );
            if (!ok) {
              return yield* Effect.fail(
                new LegacyDbPushCancelledError({ message: "context canceled" }),
              );
            }
            yield* legacySeedData(session, fs, workdir, path, seeds, applyError);
          } else if (flags.includeSeed) {
            yield* output.raw("Seed files are up to date.\n", "stderr");
          }
        }

        if (output.format === "text") {
          yield* output.raw(`Finished ${legacyAqua("supabase db push")}.\n`);
        } else {
          yield* output.success("Finished supabase db push.", {
            upToDate: false,
            dryRun: flags.dryRun,
            migrations: pending.map((p) => path.basename(p)),
            seeds: seeds.map((s) => s.path),
            roles: globals,
          });
        }
      }),
    );
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
