import type { Effect } from "effect";
import { Context } from "effect";
import type { Pool } from "pg";
import type { Output } from "../output/output.service.ts";
import type {
  SchemaEngineError,
  SchemaHistoryConflictError,
  SchemaMigrationsPrivilegeError,
} from "../schema/schema-errors.ts";
import type { MigrationFile } from "./migration-file.ts";

export type MigrationHistoryRow = {
  readonly version: string;
  readonly name: string;
};

export type MigrationHistoryStatementsRow = {
  readonly version: string;
  readonly name: string;
  readonly statements: ReadonlyArray<string>;
};

export type MigrationApplyResult = {
  readonly applied: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
  readonly recorded?: ReadonlyArray<string>;
};

interface MigrationRunnerShape {
  readonly listRemote: (
    pool: Pool,
  ) => Effect.Effect<
    ReadonlyArray<MigrationHistoryRow>,
    SchemaEngineError | SchemaMigrationsPrivilegeError
  >;
  readonly listRemoteStatements: (
    pool: Pool,
  ) => Effect.Effect<
    ReadonlyArray<MigrationHistoryStatementsRow>,
    SchemaEngineError | SchemaMigrationsPrivilegeError
  >;
  readonly showServerVersion: (pool: Pool) => Effect.Effect<string | undefined>;
  readonly listInstalledExtensions: (
    pool: Pool,
  ) => Effect.Effect<ReadonlyArray<string>, SchemaEngineError | SchemaMigrationsPrivilegeError>;
  readonly applyPending: (
    pool: Pool,
    local: ReadonlyArray<MigrationFile>,
  ) => Effect.Effect<
    MigrationApplyResult,
    SchemaEngineError | SchemaHistoryConflictError | SchemaMigrationsPrivilegeError,
    Output
  >;
  readonly markApplied: (
    pool: Pool,
    files: ReadonlyArray<MigrationFile>,
  ) => Effect.Effect<void, SchemaEngineError | SchemaMigrationsPrivilegeError>;
}

export class MigrationRunner extends Context.Service<MigrationRunner, MigrationRunnerShape>()(
  "supabase/migrations/MigrationRunner",
) {}
