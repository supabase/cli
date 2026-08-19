import { Effect } from "effect";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { SchemaDraftConflictError } from "../schema/schema-errors.ts";
import { SchemaStateStore } from "../schema/schema-state.service.ts";
import type { SchemaCommandResult } from "../schema/schema-types.ts";
import { MigrationRepository } from "./migration-repository.service.ts";
import { MigrationRunner } from "./migration-runner.service.ts";

export const applyMigrations = Effect.fn("migrations.apply")(function* () {
  const targets = yield* DatabaseTargetResolver;
  const repository = yield* MigrationRepository;
  const runner = yield* MigrationRunner;
  const state = yield* SchemaStateStore;
  const journal = yield* state.readJournal;
  if (
    journal._tag === "Some" &&
    journal.value.declarativelyAhead &&
    journal.value.generated !== true
  ) {
    return yield* new SchemaDraftConflictError({
      detail: "A declarative draft is active on the local database.",
      suggestion:
        "Run `supabase schema generate`, reset the local database, or discard the draft before applying migration files.",
    });
  }
  const target = yield* targets.resolve({ kind: "local" });
  const local = yield* repository.listLocal;

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const pool = yield* acquireDatabasePool(target.connectionString);
      const result = yield* runner.applyPending(pool, local);
      return {
        status: "clean",
        message:
          result.applied.length === 0
            ? "No pending migrations."
            : `Applied ${result.applied.length} migration(s): ${result.applied.join(", ")}`,
        data: {
          status: "clean",
          applied: result.applied,
          skipped: result.skipped,
          target: target.identity,
          mutated_database: result.applied.length > 0,
          mutated_files: false,
        },
        nextActions: [],
        mutatedDatabase: result.applied.length > 0,
        mutatedFiles: false,
      } satisfies SchemaCommandResult;
    }),
  );
});
