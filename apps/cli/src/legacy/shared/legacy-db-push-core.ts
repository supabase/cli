import { Effect, FileSystem, Option, Path } from "effect";

import { legacyPromptYesNo } from "../../shared/legacy/legacy-prompt-yes-no.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../../shared/output/errors.ts";
import { Output } from "../../shared/output/output.service.ts";
import {
  legacyListLocalMigrations,
  legacyTryCacheMigrationsCatalog,
} from "./legacy-pgdelta.cache.ts";
import { type LegacyPgDeltaContext } from "./legacy-pgdelta.ts";
import { legacyParseBoolEnv } from "./legacy-diff-engine.ts";
import {
  LEGACY_ERR_MISSING_LOCAL,
  LEGACY_ERR_MISSING_REMOTE,
  legacyFindPendingMigrations,
  legacyIncludeAllPending,
  legacySuggestIgnoreFlag,
} from "./legacy-migration-pending.ts";
import { type LegacySeedFile, legacyGetPendingSeeds, legacySeedData } from "./legacy-seed-ops.ts";
import {
  LegacyDbPushApplyError,
  LegacyDbPushCancelledError,
  LegacyDbPushMissingLocalError,
  LegacyDbPushMissingRemoteError,
  LegacyDbPushRolesError,
} from "../commands/db/push/push.errors.ts";
import { legacyAqua, legacyBold } from "./legacy-colors.ts";
import type { LegacyDbTomlValues } from "./legacy-db-config.toml-read.ts";
import { redactLegacyConnectionString } from "./legacy-db-config.parse.ts";
import { LegacyDbConnection, type LegacyPgConnInput } from "./legacy-db-connection.service.ts";
import { legacyResolveLocalProjectId, legacySanitizeProjectId } from "./legacy-docker-ids.ts";
import { legacyApplyMigrations, legacySeedGlobals } from "./legacy-migration-apply.ts";
import {
  legacyListRemoteMigrations,
  legacySuggestRevertHistory,
} from "./legacy-migration-history.ts";
import { legacyToPostgresURL } from "./legacy-postgres-url.ts";
import { legacyUpsertVaultSecrets } from "./legacy-vault.ts";

const CUSTOM_ROLES_PATH = "supabase/roles.sql";

const toSlash = (p: string): string => p.replaceAll("\\", "/");

/** `confirmPushAll` — bold filenames. */
const confirmPushAll = (filenames: ReadonlyArray<string>): string =>
  filenames.map((name) => ` • ${legacyBold(name)}\n`).join("");

/** `confirmSeedAll` — bold paths, hash notice. */
const confirmSeedAll = (seeds: ReadonlyArray<LegacySeedFile>): string =>
  seeds
    .map((seed) => ` • ${legacyBold(seed.dirty ? `${seed.path} (hash update)` : seed.path)}\n`)
    .join("");

const applyError = (message: string) => new LegacyDbPushApplyError({ message });

/**
 * Everything `push.Run` does once its target connection AND config are
 * already resolved. Shared by two
 * callers, following the same structure — `push.Run` never
 * resolves the project ref or loads `config.toml` itself, it just uses
 * whatever its caller already resolved:
 *
 * - `db push` (`push.handler.ts`) resolves `--db-url`/`--linked`/`--local` via
 * `LegacyDbConfigResolver`/`LegacyProjectRefResolver`, loads + validates
 * `config.toml` itself (so the "Loading config override" line — printed by
 * the config-load path, which runs before `push.Run` — prints before this
 * core runs), then calls this core with the resolved connection.
 * - `bootstrap` calls `push.Run(ctx, false, false, true, true, config, fsys)`
 * directly — it never re-resolves the
 * project ref or db config for push, reusing the config it already derived
 * for `.env`. `bootstrap.handler.ts` mirrors that: it passes its own
 * `workdir` / `projectRef` / connection directly, never touching
 * `LegacyProjectRefResolver` or `LegacyDbConfigResolver` (which key off
 * `LegacyCliConfig.workdir` — stale after bootstrap's `process.chdir`, see
 * bootstrap.handler.ts's workdir comments).
 *
 * The "DRY RUN: …" heads-up line is the literal first line of `push.Run` —
 * i.e. it prints AFTER the connection-resolution phase's
 * own output (e.g. "Initialising login role..."), not before — so it lives
 * here, right before "Connecting to...", not at either caller's call site.
 */
export interface LegacyDbPushCoreInput {
  /** Absolute project directory (never read from `LegacyCliConfig.workdir`). */
  readonly workdir: string;
  /** Resolved project ref, or `""` for `--local` / `--db-url`. */
  readonly projectRef: string;
  readonly conn: LegacyPgConnInput;
  readonly isLocal: boolean;
  /**
   * Whether `--local` (not `--db-url`/`--linked`) was the explicit target
   * selector — distinct from `isLocal` (whether the *resolved* connection
   * happens to point at a local address, e.g. a `--db-url` pointing at
   * `127.0.0.1`). Only feeds the "missing local migrations" repair
   * suggestion's `--local` flag (`connType === "local"` check,
   * `push.handler.ts`). `bootstrap` never selects `--local`, so it is always
   * `false` there.
   */
  readonly repairSuggestsLocalFlag: boolean;
  /**
   * Gates the "DRY RUN: …" heads-up line, the "Would push/seed/create …"
   * plan, and the JSON `dryRun` field — matches Go's single `dryRun` check at
   * the top of `push.Run`.
   */
  readonly dryRun: boolean;
  readonly includeAll: boolean;
  readonly includeRoles: boolean;
  readonly includeSeed: boolean;
  readonly includeVault: boolean;
  readonly dnsResolver: "native" | "https";
  /**
   * `LegacyCliConfig.projectId` (`SUPABASE_PROJECT_ID` env override only) — the
   * top precedence tier of the pg-delta Docker-volume id. Combined internally
   * with `toml.projectId`, `projectRef`, and a workdir-basename default via
   * {@link legacyResolveLocalProjectId}, mirroring `Config.ProjectId`
   * resolution: env override → config.toml `project_id` → `flags.ProjectRef`
   * (when non-empty) → workdir basename. That third tier comes from
   * `flags.LoadConfig` seeding
   * `utils.Config.ProjectId = ProjectRef` *before* `Config.Load` runs, so on
   * the linked path (default `db push`, and bootstrap — both resolve
   * `ProjectRef` before loading config) a config.toml that omits `project_id`
   * (e.g. a downloaded bootstrap template's own file) keeps the linked ref
   * rather than falling to the workdir basename; only `--local`/`--db-url`
   * (where Go never seeds `ProjectRef`) fall straight to the basename.
   * Passing this env-only tier straight through as the id (as bootstrap's own
   * `config.toml` is scaffolded fresh mid-handler, after `LegacyCliConfig` was
   * already built) would bind the pg-delta edge-runtime cache volume to the
   * generic `supabase_edge_runtime_` name shared by every unrelated project.
   * The resolved id is sanitized ({@link legacySanitizeProjectId}) before it
   * reaches {@link LegacyPgDeltaContext.projectId} — `Config.Validate`
   * rewrites `Config.ProjectId` to its
   * sanitized form once at config-load time, so every later reader (including
   * `EdgeRuntimeId`) sees the already-sanitized value; an unsanitized
   * `project_id` (e.g. `"my app"` from a downloaded bootstrap template) would
   * otherwise reach the Docker volume name unescaped.
   */
  readonly projectId: Option.Option<string>;
  /** Already loaded + validated `config.toml`, e.g. via `legacyCheckDbToml`. */
  readonly toml: LegacyDbTomlValues;
  /** Already resolved confirm-prompt default, e.g. via `legacyResolveYesWithProjectEnv`. */
  readonly yes: boolean;
  /**
   * Standalone `db push` emits a `--output-format` json/stream-json success
   * result for its own invocation; `bootstrap` suppresses it (it emits its own
   * top-level result), matching `legacyProjectCreateCore`'s `emitStructuredResult`.
   */
  readonly emitStructuredResult: boolean;
}

export const legacyDbPushCore = Effect.fnUntraced(function* (input: LegacyDbPushCoreInput) {
  const output = yield* Output;
  const dbConn = yield* LegacyDbConnection;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const {
    workdir,
    projectRef,
    conn,
    isLocal,
    repairSuggestsLocalFlag,
    dryRun,
    includeAll,
    includeRoles,
    includeSeed,
    includeVault,
    dnsResolver,
    projectId,
    toml,
    yes,
    emitStructuredResult,
  } = input;

  const vaultSecrets = toml.vault;

  // Literal first line of `push.Run` — prints AFTER the
  // caller's own connection-resolution output (e.g. "Loading config override",
  // "Initialising login role..."), never before.
  if (dryRun) {
    yield* output.raw("DRY RUN: migrations will *not* be pushed to the database.\n", "stderr");
  }

  const databaseName = isLocal ? "local database" : "remote database";
  const statusTarget = isLocal ? "Local database" : "Remote database";

  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* output.raw(`Connecting to ${isLocal ? "local" : "remote"} database...\n`, "stderr");
      const session = yield* dbConn.connect(conn, { isLocal, dnsResolver });

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
              suggestion: legacySuggestRevertHistory(result.versions, repairSuggestsLocalFlag),
            }),
          );
        }
        if (result.kind === "missing-remote") {
          if (!includeAll) {
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
      if (includeSeed) {
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
      if (includeRoles) {
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
        } else if (emitStructuredResult) {
          yield* output.success(`${statusTarget} is up to date.`, {
            upToDate: true,
            dryRun,
            migrations: [],
            seeds: [],
            roles: [],
          });
        }
        return;
      }

      if (dryRun) {
        if (globals.length > 0) {
          yield* output.raw(`Would create custom roles ${legacyBold(globals[0]!)}...\n`, "stderr");
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
              new LegacyDbPushCancelledError({ message: CONTEXT_CANCELED_MESSAGE }),
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
              new LegacyDbPushCancelledError({ message: CONTEXT_CANCELED_MESSAGE }),
            );
          }
          if (includeVault) {
            yield* legacyUpsertVaultSecrets(session, vaultSecrets);
          }
          yield* legacyApplyMigrations(session, fs, path, pending, applyError);
          const cacheEnabled =
            toml.pgDelta.enabled ||
            legacyParseBoolEnv(toml.envLookup("SUPABASE_EXPERIMENTAL_PG_DELTA"));
          const pgDeltaCtx: LegacyPgDeltaContext = {
            // `flags.LoadConfig` seeds `Config.ProjectId = ProjectRef` before
            // `Config.Load` runs, so an absent config.toml `project_id` retains the
            // linked ref, not the workdir basename — that fallback only applies when
            // `flags.ProjectRef` is unset (`--local`/`--db-url`, where `projectRef` is
            // `""` here too, see `LegacyDbPushCoreInput.projectId`'s doc comment).
            // `legacyResolveLocalProjectId` itself only knows the env/toml/basename
            // tiers, so splice this third tier in by feeding it as `tomlProjectId`'s
            // own fallback rather than widening that helper's signature for its two
            // other (local-only, `projectRef`-less) callers.
            projectId: legacySanitizeProjectId(
              legacyResolveLocalProjectId(
                Option.getOrUndefined(projectId),
                Option.getOrUndefined(toml.projectId) ??
                  (projectRef !== "" ? projectRef : undefined),
                workdir,
              ),
            ),
            cwd: workdir,
            npmVersion: Option.getOrUndefined(toml.pgDelta.npmVersion),
            denoVersion: toml.denoVersion,
            projectEnv: toml.projectEnv,
          };
          yield* legacyTryCacheMigrationsCatalog(fs, path, pgDeltaCtx, {
            enabled: cacheEnabled,
            targetUrl: legacyToPostgresURL(conn),
            conn,
            isLocal,
            migrationsDir: path.join(workdir, "supabase", "migrations"),
          }).pipe(
            Effect.catch((error) =>
              output.raw(
                `Warning: failed to cache migrations catalog: ${redactLegacyConnectionString(error.message)}\n`,
                "stderr",
              ),
            ),
          );
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
              new LegacyDbPushCancelledError({ message: CONTEXT_CANCELED_MESSAGE }),
            );
          }
          yield* legacySeedData(session, fs, workdir, path, seeds, applyError);
        } else if (includeSeed) {
          yield* output.raw("Seed files are up to date.\n", "stderr");
        }
      }

      if (output.format === "text") {
        yield* output.raw(`Finished ${legacyAqua("supabase db push")}.\n`);
      } else if (emitStructuredResult) {
        yield* output.success("Finished supabase db push.", {
          upToDate: false,
          dryRun,
          migrations: pending.map((p) => path.basename(p)),
          seeds: seeds.map((s) => s.path),
          roles: globals,
        });
      }
    }),
  );
});
