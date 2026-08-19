import { Effect } from "effect";
import { applyMigrations } from "../../../../shared/migrations/apply-migrations.ts";
import { renderSchemaResult } from "../../../../shared/schema/schema-render.ts";

export const legacyMigrationsApply = Effect.fn("legacy.migrations.apply")(function* () {
  const result = yield* applyMigrations();
  yield* renderSchemaResult("Apply migrations", result);
});
