import type { Effect } from "effect";
import { Context } from "effect";
import type { SchemaMigrationNameError, SchemaWorkspaceIoError } from "../schema/schema-errors.ts";
import type { MigrationFile } from "./migration-file.ts";

type GeneratedMigrationUnit = {
  readonly suffix: string | null;
  readonly sql: string;
  readonly transactional: boolean;
};

interface MigrationRepositoryShape {
  readonly listLocal: Effect.Effect<ReadonlyArray<MigrationFile>, SchemaWorkspaceIoError>;
  readonly createEmpty: (
    name: string,
    content?: string,
  ) => Effect.Effect<MigrationFile, SchemaMigrationNameError | SchemaWorkspaceIoError>;
  readonly writeGenerated: (input: {
    readonly name: string;
    readonly baseMillis: number;
    readonly files: ReadonlyArray<GeneratedMigrationUnit>;
  }) => Effect.Effect<
    ReadonlyArray<MigrationFile>,
    SchemaMigrationNameError | SchemaWorkspaceIoError
  >;
  readonly remove: (
    files: ReadonlyArray<MigrationFile>,
  ) => Effect.Effect<void, SchemaWorkspaceIoError>;
}

export class MigrationRepository extends Context.Service<
  MigrationRepository,
  MigrationRepositoryShape
>()("supabase/migrations/MigrationRepository") {}
