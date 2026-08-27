import { Effect } from "effect";
import { readExportManifest } from "@supabase/pg-delta/frontends";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { parseTargetSelector, redactConnectionString } from "../database/database-target.ts";
import { SchemaDraftConflictError } from "./schema-errors.ts";
import { SchemaStateStore } from "./schema-state.service.ts";
import type { SchemaCommandResult } from "./schema-types.ts";
import { SchemaWorkspace } from "./schema-workspace.service.ts";
import { PgDeltaSchemaEngine } from "./pg-delta-engine.service.ts";
import { formatFileSummary, formatNextAction } from "./schema-output.ts";
import { MigrationRepository } from "../migrations/migration-repository.service.ts";
import { MigrationRunner } from "../migrations/migration-runner.service.ts";

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
  const runner = yield* MigrationRunner;

  const selector = parseTargetSelector(input.from ?? "local");
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
        const remoteHistory = yield* runner.listRemote(pool);
        const from = selector.kind === "url" ? "<connection-string>" : selector.kind;

        const summary = installed.classification;
        const nextActions = [
          ...(mode === "output"
            ? [
                formatNextAction(
                  "to replace the managed schema",
                  `supabase schema pull --from ${from} --force`,
                ),
              ]
            : localMigrations.length > 0
              ? [formatNextAction("to check they match", "supabase schema generate --dry-run")]
              : remoteHistory.length > 0
                ? [
                    formatNextAction(
                      "to fetch missing files",
                      `supabase migrations pull --from ${from}`,
                    ),
                  ]
                : [
                    formatNextAction(
                      "to create a baseline",
                      "supabase schema generate --baseline --name initial_schema",
                    ),
                  ]),
          ...(summary.unmanaged.length > 0
            ? [
                formatNextAction(
                  "to keep hand-authored SQL",
                  "move those files to supabase/schemas/_custom/",
                ),
              ]
            : []),
        ];

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
