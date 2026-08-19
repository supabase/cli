import type { Effect } from "effect";
import { Context } from "effect";
import type { Pool } from "pg";
import type { SchemaEngineError, SchemaHistoryConflictError } from "../schema/schema-errors.ts";
import type { MigrationFile } from "./migration-file.ts";

export type MigrationHistoryRow = {
  readonly version: string;
  readonly name: string;
};

export type MigrationApplyResult = {
  readonly applied: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
};

interface MigrationRunnerShape {
  readonly listRemote: (
    pool: Pool,
  ) => Effect.Effect<ReadonlyArray<MigrationHistoryRow>, SchemaEngineError>;
  readonly applyPending: (
    pool: Pool,
    local: ReadonlyArray<MigrationFile>,
  ) => Effect.Effect<MigrationApplyResult, SchemaEngineError | SchemaHistoryConflictError>;
  readonly recordApplied: (
    pool: Pool,
    files: ReadonlyArray<MigrationFile>,
  ) => Effect.Effect<void, SchemaEngineError>;
}

export class MigrationRunner extends Context.Service<MigrationRunner, MigrationRunnerShape>()(
  "supabase/migrations/MigrationRunner",
) {}
