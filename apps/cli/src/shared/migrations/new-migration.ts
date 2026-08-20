import { Effect } from "effect";
import { SchemaDraftConflictError, SchemaMigrationNameError } from "../schema/schema-errors.ts";
import type { SchemaCommandResult } from "../schema/schema-types.ts";
import { SchemaStateStore } from "../schema/schema-state.service.ts";
import { SchemaWorkspace } from "../schema/schema-workspace.service.ts";
import { MigrationRepository } from "./migration-repository.service.ts";

export const newMigration = Effect.fn("migrations.new")(function* (name: string | undefined) {
  if (name === undefined || name.trim() === "") {
    return yield* new SchemaMigrationNameError({
      detail: "Migration name is required.",
      suggestion: "Pass a name, for example `supabase migrations new add_billing`.",
    });
  }
  const workspace = yield* SchemaWorkspace;
  const repository = yield* MigrationRepository;
  const state = yield* SchemaStateStore;
  const journal = yield* state.readJournal;
  if (
    journal._tag === "Some" &&
    journal.value.declarativelyAhead &&
    journal.value.generated !== true
  ) {
    return yield* new SchemaDraftConflictError({
      detail: "Migration files cannot change while a declarative draft is active.",
      suggestion: "Run `supabase schema generate`, reset the local database, or discard the draft.",
    });
  }
  const created = yield* repository.createEmpty(name.trim());
  return {
    status: "generated",
    message: `Created ${workspace.migrationsDirDisplay}/${created.fileName}`,
    data: {
      status: "generated",
      file: created.fileName,
      version: created.version,
      mutated_files: true,
      mutated_database: false,
    },
    nextActions: [
      "Write the SQL in that file, then apply it locally with `supabase migrations apply`.",
    ],
    mutatedDatabase: false,
    mutatedFiles: true,
  } satisfies SchemaCommandResult;
});
