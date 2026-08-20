import type { Effect, Scope } from "effect";
import { Context } from "effect";
import type { Pool } from "pg";
import type { ApplyOptions } from "@supabase/pg-delta/apply";
import type { ExportManifest } from "@supabase/pg-delta/frontends";
import type { SchemaApplyOutcome, SchemaPlanView, SchemaSqlFile } from "./schema-types.ts";
import type { SchemaEngineError } from "./schema-errors.ts";
import type { SchemaShadow } from "./schema-shadow.ts";

export type SchemaExportResult = {
  readonly files: ReadonlyArray<SchemaSqlFile>;
  readonly manifest: ExportManifest & { readonly files: ReadonlyArray<string> };
  readonly snapshot: string;
  readonly engineVersion: string;
};

export type SchemaPlanFilesInput = {
  readonly targetPool: Pool;
  readonly shadowPool: Pool;
  readonly files: ReadonlyArray<SchemaSqlFile>;
  readonly manifest?: ExportManifest;
  readonly allowDrops?: boolean;
};

export type SchemaDiffPoolsInput = {
  readonly sourcePool: Pool;
  readonly desiredPool: Pool;
  readonly allowDrops?: boolean;
};

type SchemaApplyPlanInput = {
  readonly pool: Pool;
  readonly plan: SchemaPlanView;
  readonly applyOptions?: ApplyOptions;
};

interface PgDeltaSchemaEngineShape {
  readonly exportSchema: (pool: Pool) => Effect.Effect<SchemaExportResult, SchemaEngineError>;
  readonly planFiles: (
    input: SchemaPlanFilesInput,
  ) => Effect.Effect<SchemaPlanView, SchemaEngineError>;
  readonly diffPools: (
    input: SchemaDiffPoolsInput,
  ) => Effect.Effect<SchemaPlanView, SchemaEngineError>;
  readonly applyPlan: (
    input: SchemaApplyPlanInput,
  ) => Effect.Effect<SchemaApplyOutcome, SchemaEngineError>;
  readonly provisionShadow: Effect.Effect<SchemaShadow, SchemaEngineError, Scope.Scope>;
  readonly provisionMigrations: Effect.Effect<SchemaShadow, SchemaEngineError, Scope.Scope>;
}

export class PgDeltaSchemaEngine extends Context.Service<
  PgDeltaSchemaEngine,
  PgDeltaSchemaEngineShape
>()("supabase/schema/PgDeltaSchemaEngine") {}
