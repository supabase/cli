import { Effect, Layer } from "effect";
import type { Pool } from "pg";
import { SchemaEngineError, SchemaHistoryConflictError } from "../schema/schema-errors.ts";
import type { MigrationFile } from "./migration-file.ts";
import {
  MigrationRunner,
  type MigrationApplyResult,
  type MigrationHistoryRow,
} from "./migration-runner.service.ts";

const ENSURE_HISTORY = `
BEGIN;
SET LOCAL lock_timeout = '4s';
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY);
ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[];
ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text;
COMMIT;
`;

const LIST_HISTORY =
  "SELECT version, coalesce(name, '') AS name FROM supabase_migrations.schema_migrations ORDER BY version";
const LIST_HISTORY_VERSION_ONLY =
  "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version";
const INSERT_HISTORY =
  "INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES($1, $2, $3)";

const MISSING_HISTORY_CODES = new Set(["3F000", "42P01"]);

const engineError = (detail: string) =>
  new SchemaEngineError({
    detail,
    suggestion: "Check the database connection and migration SQL, then retry.",
  });

function postgresErrorCode(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return undefined;
  }
  const { code } = cause;
  return typeof code === "string" ? code : undefined;
}

function postgresErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isMissingMigrationHistory(cause: unknown): boolean {
  const code = postgresErrorCode(cause);
  if (code !== undefined) return MISSING_HISTORY_CODES.has(code);
  const message = postgresErrorMessage(cause);
  return (
    /relation .* does not exist/iu.test(message) && !/column .* does not exist/iu.test(message)
  );
}

function isMissingNameColumn(cause: unknown): boolean {
  return /column ["']?name["']? does not exist/iu.test(postgresErrorMessage(cause));
}

export const migrationRunnerLayer = Layer.succeed(
  MigrationRunner,
  MigrationRunner.of({
    listRemote: (pool: Pool) =>
      Effect.tryPromise({
        try: async () => {
          try {
            const result = await pool.query<MigrationHistoryRow>(LIST_HISTORY);
            return result.rows;
          } catch (cause) {
            if (isMissingMigrationHistory(cause)) return [];
            if (isMissingNameColumn(cause)) {
              const result = await pool.query<{ version: string }>(LIST_HISTORY_VERSION_ONLY);
              return result.rows.map((row) => ({ version: row.version, name: "" }));
            }
            throw cause;
          }
        },
        catch: (cause) => engineError(postgresErrorMessage(cause)),
      }),
    applyPending: (pool: Pool, local: ReadonlyArray<MigrationFile>) =>
      Effect.gen(function* () {
        const remote = yield* Effect.tryPromise({
          try: async () => {
            await pool.query(ENSURE_HISTORY);
            const result = await pool.query<MigrationHistoryRow>(LIST_HISTORY);
            return result.rows;
          },
          catch: (cause) => engineError(cause instanceof Error ? cause.message : String(cause)),
        });
        const remoteVersions = new Set(remote.map((row) => row.version));
        const pending = local.filter((file) => !remoteVersions.has(file.version));
        const remoteOnly = remote.filter(
          (row) => !local.some((file) => file.version === row.version),
        );
        if (remoteOnly.length > 0 && pending.length > 0) {
          return yield* new SchemaHistoryConflictError({
            detail: `Local and remote migration histories have diverged (remote-only: ${remoteOnly
              .map((row) => row.version)
              .join(", ")}; pending: ${pending.map((file) => file.version).join(", ")}).`,
            suggestion: "Run `supabase migrations pull` or repair history before applying.",
          });
        }
        const applied: Array<string> = [];
        for (const file of pending) {
          yield* Effect.tryPromise({
            try: async () => {
              if (file.transactional) {
                await pool.query("BEGIN");
                try {
                  await pool.query(file.content);
                  await pool.query(INSERT_HISTORY, [file.version, file.name, [file.content]]);
                  await pool.query("COMMIT");
                } catch (error) {
                  await pool.query("ROLLBACK").catch(() => undefined);
                  throw error;
                }
              } else {
                await pool.query(file.content);
                await pool.query(INSERT_HISTORY, [file.version, file.name, [file.content]]);
              }
            },
            catch: (cause) =>
              engineError(
                `Failed applying ${file.fileName}: ${cause instanceof Error ? cause.message : String(cause)}`,
              ),
          });
          applied.push(file.version);
        }
        return {
          applied,
          skipped: local
            .filter((file) => remoteVersions.has(file.version))
            .map((file) => file.version),
        } satisfies MigrationApplyResult;
      }),
    markApplied: (pool: Pool, files: ReadonlyArray<MigrationFile>) =>
      Effect.tryPromise({
        try: async () => {
          await pool.query(ENSURE_HISTORY);
          const existing = await pool.query<MigrationHistoryRow>(LIST_HISTORY);
          const present = new Set(existing.rows.map((row) => row.version));
          for (const file of files) {
            if (present.has(file.version)) continue;
            await pool.query(INSERT_HISTORY, [file.version, file.name, [file.content]]);
          }
        },
        catch: (cause) =>
          engineError(
            `Failed recording migration history: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
      }),
  }),
);
