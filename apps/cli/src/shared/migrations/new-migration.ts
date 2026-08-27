import { Effect } from "effect";
import { SchemaDraftConflictError, SchemaMigrationNameError } from "../schema/schema-errors.ts";
import { formatMigrationFilePath, formatNextAction } from "../schema/schema-output.ts";
import type { SchemaCommandResult } from "../schema/schema-types.ts";
import { SchemaStateStore } from "../schema/schema-state.service.ts";
import { MigrationRepository } from "./migration-repository.service.ts";
import {
  REVOKE_API_PRIVILEGES_NAME,
  REVOKE_API_PRIVILEGES_TEMPLATE,
  revokeApiPrivilegesTemplateSql,
} from "./privilege-offer.ts";

export type NewMigrationInput = {
  readonly name?: string;
  readonly template?: typeof REVOKE_API_PRIVILEGES_TEMPLATE;
};

export const newMigration = Effect.fn("migrations.new")(function* (input: NewMigrationInput) {
  const name =
    input.name !== undefined && input.name.trim() !== ""
      ? input.name.trim()
      : input.template === REVOKE_API_PRIVILEGES_TEMPLATE
        ? REVOKE_API_PRIVILEGES_NAME
        : undefined;
  if (name === undefined) {
    return yield* new SchemaMigrationNameError({
      detail: "Migration name is required.",
      suggestion: "Pass a name, for example `supabase migrations new add_billing`.",
    });
  }
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
  const seed =
    input.template === REVOKE_API_PRIVILEGES_TEMPLATE || name === REVOKE_API_PRIVILEGES_NAME
      ? revokeApiPrivilegesTemplateSql()
      : "";
  const created = yield* repository.createEmpty(name, seed);
  return {
    status: "generated",
    message: `Created ${formatMigrationFilePath(created.fileName)}`,
    data: {
      status: "generated",
      file: created.fileName,
      version: created.version,
      mutated_files: true,
      mutated_database: false,
    },
    nextActions:
      seed.length > 0
        ? [
            formatNextAction("to deploy", "supabase migrations push"),
            formatNextAction("to apply it locally", "supabase migrations apply"),
          ]
        : [formatNextAction("to add SQL before apply or push", "edit the new file")],
    mutatedDatabase: false,
    mutatedFiles: true,
  } satisfies SchemaCommandResult;
});
