import { Effect, Option } from "effect";
import { newMigration } from "../../../../shared/migrations/new-migration.ts";
import { renderSchemaResult } from "../../../../shared/schema/schema-render.ts";
import type { MigrationsNewFlags } from "./new.command.ts";

export const migrationsNew = Effect.fn("migrations.new")(function* (flags: MigrationsNewFlags) {
  const result = yield* newMigration(Option.getOrUndefined(flags.name));
  yield* renderSchemaResult("Create migration", result);
});
