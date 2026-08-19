import type { Effect } from "effect";
import { Context } from "effect";
import type { SqlFileClassification } from "@supabase/pg-delta/frontends";
import type { SchemaSqlFile } from "./schema-types.ts";
import type {
  SchemaDeclarationsExistError,
  SchemaUnmanagedFilesError,
  SchemaWorkspaceIoError,
} from "./schema-errors.ts";

type SchemaInstallMode = "init" | "force" | "output";

export type SchemaInstallInput = {
  readonly files: ReadonlyArray<SchemaSqlFile>;
  readonly manifest: Record<string, unknown>;
  readonly mode: SchemaInstallMode;
  readonly outputDir?: string;
  readonly pruneUnmanaged: boolean;
};

export type SchemaInstallResult = {
  readonly directory: string;
  readonly directoryDisplay: string;
  readonly classification: SqlFileClassification;
  readonly replaced: boolean;
  readonly manifestPath: string;
};

interface SchemaWorkspaceShape {
  readonly schemasDir: string;
  readonly schemasDirDisplay: string;
  readonly migrationsDir: string;
  readonly migrationsDirDisplay: string;
  readonly customDir: string;
  readonly checkpointPath: string;
  readonly journalPath: string;
  readonly lockPath: string;
  readonly readDeclarationFiles: Effect.Effect<
    ReadonlyArray<SchemaSqlFile>,
    SchemaWorkspaceIoError
  >;
  readonly readExistingSql: (
    directory?: string,
  ) => Effect.Effect<ReadonlyMap<string, string>, SchemaWorkspaceIoError>;
  readonly classifyProposed: (
    proposed: ReadonlyArray<SchemaSqlFile>,
    directory?: string,
  ) => Effect.Effect<SqlFileClassification, SchemaWorkspaceIoError>;
  readonly installExport: (
    input: SchemaInstallInput,
  ) => Effect.Effect<
    SchemaInstallResult,
    SchemaDeclarationsExistError | SchemaUnmanagedFilesError | SchemaWorkspaceIoError
  >;
}

export class SchemaWorkspace extends Context.Service<SchemaWorkspace, SchemaWorkspaceShape>()(
  "supabase/schema/SchemaWorkspace",
) {}
