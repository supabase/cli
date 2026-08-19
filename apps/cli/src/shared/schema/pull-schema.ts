import { Effect } from "effect";
import { readExportManifest } from "@supabase/pg-delta/frontends";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { parseTargetSelector, redactConnectionString } from "../database/database-target.ts";
import { digestFileSet } from "./schema-digest.ts";
import { SchemaDraftConflictError, SchemaTargetRequiredError } from "./schema-errors.ts";
import {
  SCHEMA_ARTIFACT_FORMAT_VERSION,
  SCHEMA_MANAGEMENT_SCOPE,
  SCHEMA_PROFILE_ID,
} from "./schema-paths.ts";
import { SchemaStateStore } from "./schema-state.service.ts";
import type { SchemaCheckpoint, SchemaCommandResult } from "./schema-types.ts";
import { SchemaWorkspace } from "./schema-workspace.service.ts";
import { PgDeltaSchemaEngine } from "./pg-delta-engine.service.ts";
import { formatFileSummary } from "./schema-output.ts";
import { MigrationRepository } from "../migrations/migration-repository.service.ts";
import { digestVersions } from "./schema-digest.ts";

export type PullSchemaInput = {
  readonly from?: string;
  readonly output?: string;
  readonly force: boolean;
  readonly pruneUnmanaged: boolean;
};

export const pullSchema = Effect.fn("schema.pull")(function* (input: PullSchemaInput) {
  const workspace = yield* SchemaWorkspace;
  const state = yield* SchemaStateStore;
  const engine = yield* PgDeltaSchemaEngine;
  const targets = yield* DatabaseTargetResolver;
  const migrations = yield* MigrationRepository;

  if (input.from === undefined) {
    return yield* new SchemaTargetRequiredError({
      detail: "schema pull requires an explicit --from target.",
      suggestion: "Pass --from local, --from linked, or --from <connection-string>.",
    });
  }

  const selector = parseTargetSelector(input.from);
  const target = yield* targets.resolve(selector);
  const mode = input.output !== undefined ? "output" : input.force ? "force" : "init";

  return yield* state.withLock(
    Effect.scoped(
      Effect.gen(function* () {
        if (mode !== "output") {
          const journal = yield* state.readJournal;
          if (
            journal._tag === "Some" &&
            journal.value.declarativelyAhead &&
            journal.value.generated !== true
          ) {
            return yield* new SchemaDraftConflictError({
              detail: "A declarative draft is active. Pull would hide ungenerated changes.",
              suggestion:
                "Run `supabase schema generate` or discard the draft before pulling the primary tree.",
            });
          }
        }

        const pool = yield* acquireDatabasePool(target.connectionString);
        const exported = yield* engine.exportSchema(pool);
        const installed = yield* workspace.installExport({
          files: exported.files,
          manifest: Object.fromEntries(Object.entries(exported.manifest)),
          mode,
          ...(input.output !== undefined ? { outputDir: input.output } : {}),
          pruneUnmanaged: input.pruneUnmanaged,
        });

        const localMigrations = yield* migrations.listLocal;
        if (mode !== "output") {
          const existingCheckpoint = yield* state.readCheckpoint;
          const previousGenerated =
            existingCheckpoint._tag === "Some"
              ? (existingCheckpoint.value.generatedMigrationVersions ?? [])
              : [];
          const previousDestructive =
            existingCheckpoint._tag === "Some"
              ? (existingCheckpoint.value.destructiveMigrationVersions ?? [])
              : [];
          const checkpoint: SchemaCheckpoint = {
            version: 1,
            declarativeDigest: digestFileSet(exported.files),
            migrationHeadDigest: digestVersions(localMigrations.map((file) => file.version)),
            profile: SCHEMA_PROFILE_ID,
            scope: SCHEMA_MANAGEMENT_SCOPE,
            engineVersion: exported.engineVersion,
            artifactFormatVersion: SCHEMA_ARTIFACT_FORMAT_VERSION,
            acceptedRenames: [],
            exportManifestIdentity: digestFileSet(
              exported.manifest.files.map((name) => ({ name, sql: name })),
            ),
            catalogSnapshot: exported.snapshot,
            ...(existingCheckpoint._tag === "Some" &&
            existingCheckpoint.value.lastGenerateName !== undefined
              ? { lastGenerateName: existingCheckpoint.value.lastGenerateName }
              : {}),
            ...(existingCheckpoint._tag === "Some" &&
            existingCheckpoint.value.lastGenerateHazards !== undefined
              ? { lastGenerateHazards: existingCheckpoint.value.lastGenerateHazards }
              : {}),
            ...(previousGenerated.length > 0
              ? { generatedMigrationVersions: previousGenerated }
              : {}),
            ...(previousDestructive.length > 0
              ? { destructiveMigrationVersions: previousDestructive }
              : {}),
          };
          yield* state.writeCheckpoint(checkpoint);
        }

        const summary = installed.classification;
        const nextActions =
          mode === "output"
            ? [
                "Inspect the side-by-side snapshot, then edit supabase/schemas or rerun with --force.",
              ]
            : localMigrations.length > 0
              ? ["supabase schema generate --dry-run"]
              : ["supabase schema generate --baseline --name initial_schema"];

        return {
          status: "clean",
          message: `Declarative schema written to ${installed.directoryDisplay}.`,
          data: {
            status: "clean",
            source: {
              kind: target.kind,
              identity: target.identity,
              connection: redactConnectionString(target.connectionString),
            },
            output: installed.directoryDisplay,
            replaced: installed.replaced,
            merge: false,
            summary: formatFileSummary(summary),
            created: summary.created,
            updated: summary.updated,
            unchanged: summary.unchanged,
            removed: summary.removed,
            unmanaged: summary.unmanaged,
            next_actions: nextActions,
            mutated_database: false,
            mutated_files: true,
            export_manifest: readExportManifest(installed.directory),
          },
          nextActions,
          mutatedDatabase: false,
          mutatedFiles: true,
        } satisfies SchemaCommandResult;
      }),
    ),
  );
});
