import { Effect } from "effect";
import { acquireDatabasePool } from "../database/database-pool.ts";
import { DatabaseTargetResolver } from "../database/database-target.service.ts";
import { SchemaDraftConflictError } from "../schema/schema-errors.ts";
import { SchemaStateStore } from "../schema/schema-state.service.ts";
import type { SchemaCommandResult } from "../schema/schema-types.ts";
import { applyLocalPending } from "./apply-local-pending.ts";
import { MigrationRepository } from "./migration-repository.service.ts";

export const applyMigrations = Effect.fn("migrations.apply")(function* () {
  const targets = yield* DatabaseTargetResolver;
  const repository = yield* MigrationRepository;
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
      const result = yield* applyLocalPending(pool, local);
      const recorded = result.recorded ?? [];
      const mutatedDatabase = result.applied.length > 0 || recorded.length > 0;
      return {
        status: "clean",
        message:
          recorded.length > 0
            ? `Recorded ${recorded.length} already-applied migration(s): ${recorded.join(", ")}`
            : result.applied.length === 0
              ? "No pending migrations."
              : `Applied ${result.applied.length} migration(s): ${result.applied.join(", ")}`,
        data: {
          status: "clean",
          applied: result.applied,
          recorded,
          skipped: result.skipped,
          target: target.identity,
          mutated_database: mutatedDatabase,
          mutated_files: false,
        },
        nextActions: [],
        mutatedDatabase,
        mutatedFiles: false,
      } satisfies SchemaCommandResult;
    }),
  );
});
