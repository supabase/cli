import { Effect, Option } from "effect";
import { newMigration } from "../../../../shared/migrations/new-migration.ts";
import { renderSchemaResult } from "../../../../shared/schema/schema-render.ts";
import type { LegacyMigrationsNewFlags } from "./new.command.ts";

export const legacyMigrationsNew = Effect.fn("legacy.migrations.new")(function* (
  flags: LegacyMigrationsNewFlags,
) {
  const result = yield* newMigration(Option.getOrUndefined(flags.name));
  yield* renderSchemaResult("Create migration", result);
});
