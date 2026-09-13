import { Effect, FileSystem, Path } from "effect";

import { promptYesNo } from "./prompt-yes-no.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../shared/output/errors.ts";
import { Output } from "../shared/output/output.service.ts";
import { listLocalMigrations } from "./migration-list.ts";
import {
  ERR_MISSING_LOCAL,
  ERR_MISSING_REMOTE,
  findPendingMigrations,
  includeAllPending,
  suggestIgnoreFlag,
} from "./migration-pending.ts";
import { type SeedFile, getPendingSeeds, seedData } from "./seed-ops.ts";
import {
  DbPushApplyError,
  DbPushCancelledError,
  DbPushMissingLocalError,
  DbPushMissingRemoteError,
  DbPushRolesError,
} from "../commands/db/push/push.errors.ts";
import { aqua, bold } from "./colors.ts";
import type { DbTomlValues } from "./db-config.toml-read.ts";
import { DbConnection, type PgConnInput } from "./db-connection.service.ts";
import { applyMigrations, seedGlobals } from "./migration-apply.ts";
import { listRemoteMigrations, suggestRevertHistory } from "./migration-history.ts";
import { upsertVaultSecrets } from "./vault.ts";

const CUSTOM_ROLES_PATH = "supabase/roles.sql";

const toSlash = (p: string): string => p.replaceAll("\\", "/");

const confirmPushAll = (filenames: ReadonlyArray<string>): string =>
  filenames.map((name) => ` • ${bold(name)}\n`).join("");

const confirmSeedAll = (seeds: ReadonlyArray<SeedFile>): string =>
  seeds
    .map((seed) => ` • ${bold(seed.dirty ? `${seed.path} (hash update)` : seed.path)}\n`)
    .join("");

const applyError = (message: string) => new DbPushApplyError({ message });

/**
 * Everything `db push` does once its target connection and config are already resolved. Callers
 * (`db push`, `bootstrap`) resolve the project ref, connection, and `config.toml` themselves and
 * pass the results in; this core never touches `ProjectRefResolver`/`DbConfigResolver` itself.
 *
 * The "DRY RUN: …" heads-up line prints first here, after the caller's own connection-resolution
 * output (e.g. "Initialising login role..."), so it lives here rather than at either call site.
 */
export interface DbPushCoreInput {
  /** Absolute project directory (never read from `CommandSettings.workdir`). */
  readonly workdir: string;
  /** Resolved project ref, or `""` for `--local` / `--db-url`. */
  readonly projectRef: string;
  readonly conn: PgConnInput;
  readonly isLocal: boolean;
  /**
   * Whether `--local` (not `--db-url`/`--linked`) was the explicit target selector, distinct
   * from `isLocal` (whether the resolved connection happens to point at a local address, e.g. a
   * `--db-url` pointing at `127.0.0.1`). Only feeds the "missing local migrations" repair
   * suggestion's `--local` flag; `bootstrap` never selects `--local`, so it is always `false`
   * there.
   */
  readonly repairSuggestsLocalFlag: boolean;
  /**
   * Gates the "DRY RUN: …" heads-up line, the "Would push/seed/create …" plan, and the JSON
   * `dryRun` field.
   */
  readonly dryRun: boolean;
  readonly includeAll: boolean;
  readonly includeRoles: boolean;
  readonly includeSeed: boolean;
  readonly includeVault: boolean;
  readonly dnsResolver: "native" | "https";
  /** Already loaded + validated `config.toml`, e.g. via `checkDbToml`. */
  readonly toml: DbTomlValues;
  /** Already resolved confirm-prompt default, e.g. via `resolveYesWithProjectEnv`. */
  readonly yes: boolean;
  /**
   * Standalone `db push` emits a `--output-format` json/stream-json success result for its own
   * invocation; `bootstrap` suppresses it since it emits its own top-level result instead.
   */
  readonly emitStructuredResult: boolean;
}

export const dbPushCore = Effect.fnUntraced(function* (input: DbPushCoreInput) {
  const output = yield* Output;
  const dbConn = yield* DbConnection;
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
    toml,
    yes,
    emitStructuredResult,
  } = input;

  const vaultSecrets = toml.vault;

  // Prints first here, after the caller's own connection-resolution output (e.g. "Loading
  // config override", "Initialising login role..."), never before.
  if (dryRun) {
    yield* output.raw("DRY RUN: migrations will *not* be pushed to the database.\n", "stderr");
  }

  const databaseName = isLocal ? "local database" : "remote database";
  const statusTarget = isLocal ? "Local database" : "Remote database";

  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* output.raw(`Connecting to ${isLocal ? "local" : "remote"} database...\n`, "stderr");
      const session = yield* dbConn.connect(conn, { isLocal, dnsResolver });

      let pending: ReadonlyArray<string> = [];
      if (!toml.migrationsEnabled) {
        yield* output.raw(
          `Skipping migrations because it is disabled in config.toml for project: ${projectRef}\n`,
          "stderr",
        );
      } else {
        const migrationsDir = path.join(workdir, "supabase", "migrations");
        const remote = yield* listRemoteMigrations(session);
        const local = yield* listLocalMigrations(fs, path, migrationsDir);
        const result = findPendingMigrations(local, remote);
        if (result.kind === "missing-local") {
          return yield* Effect.fail(
            new DbPushMissingLocalError({
              message: ERR_MISSING_LOCAL,
              suggestion: suggestRevertHistory(result.versions, repairSuggestsLocalFlag),
            }),
          );
        }
        if (result.kind === "missing-remote") {
          if (!includeAll) {
            // Workdir-relative paths for `suggestIgnoreFlag`.
            const relPaths = result.paths.map((p) => toSlash(path.relative(workdir, p)));
            return yield* Effect.fail(
              new DbPushMissingRemoteError({
                message: ERR_MISSING_REMOTE,
                suggestion: suggestIgnoreFlag(relPaths),
              }),
            );
          }
          pending = includeAllPending(local, remote.length, result.paths);
        } else {
          pending = result.pending;
        }
      }

      let seeds: ReadonlyArray<SeedFile> = [];
      if (includeSeed) {
        if (!toml.seed.enabled) {
          yield* output.raw(
            `Skipping seed because it is disabled in config.toml for project: ${projectRef}\n`,
            "stderr",
          );
        } else {
          seeds = yield* getPendingSeeds(session, fs, path, toml.seed.sqlPaths, workdir);
        }
      }

      const globals: Array<string> = [];
      if (includeRoles) {
        const exists = yield* fs.exists(path.join(workdir, CUSTOM_ROLES_PATH)).pipe(
          Effect.mapError(
            (cause) =>
              new DbPushRolesError({
                message: `failed to find custom roles: ${cause.message}`,
              }),
          ),
        );
        if (exists) globals.push(CUSTOM_ROLES_PATH);
      }

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
          yield* output.raw(`Would create custom roles ${bold(globals[0]!)}...\n`, "stderr");
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
        if (globals.length > 0) {
          const ok = yield* promptYesNo(
            output,
            yes,
            "Do you want to create custom roles in the database cluster?",
            true,
          );
          if (!ok) {
            return yield* Effect.fail(
              new DbPushCancelledError({ message: CONTEXT_CANCELED_MESSAGE }),
            );
          }
          yield* seedGlobals(
            session,
            fs,
            path,
            globals.map((g) => path.join(workdir, g)),
            applyError,
          );
        }

        if (pending.length > 0) {
          const ok = yield* promptYesNo(
            output,
            yes,
            `Do you want to push these migrations to the ${databaseName}?\n${confirmPushAll(pending.map((p) => path.basename(p)))}`,
            true,
          );
          if (!ok) {
            return yield* Effect.fail(
              new DbPushCancelledError({ message: CONTEXT_CANCELED_MESSAGE }),
            );
          }
          if (includeVault) {
            yield* upsertVaultSecrets(session, vaultSecrets);
          }
          yield* applyMigrations(session, fs, path, pending, applyError);
        } else {
          yield* output.raw("Schema migrations are up to date.\n", "stderr");
        }

        if (seeds.length > 0) {
          const ok = yield* promptYesNo(
            output,
            yes,
            `Do you want to seed the ${databaseName} with these files?\n${confirmSeedAll(seeds)}`,
            true,
          );
          if (!ok) {
            return yield* Effect.fail(
              new DbPushCancelledError({ message: CONTEXT_CANCELED_MESSAGE }),
            );
          }
          yield* seedData(session, fs, workdir, path, seeds, applyError);
        } else if (includeSeed) {
          yield* output.raw("Seed files are up to date.\n", "stderr");
        }
      }

      if (output.format === "text") {
        yield* output.raw(`Finished ${aqua("supabase db push")}.\n`);
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
