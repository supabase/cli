import { Effect, Option } from "effect";
import { listMigrations } from "../../../../shared/migrations/list-migrations.ts";
import { renderSchemaResult } from "../../../../shared/schema/schema-render.ts";
import type { LegacyMigrationsListFlags } from "./list.command.ts";

export const legacyMigrationsList = Effect.fn("legacy.migrations.list")(function* (
  flags: LegacyMigrationsListFlags,
) {
  const result = yield* listMigrations({ against: Option.getOrUndefined(flags.against) });
  yield* renderSchemaResult("List migrations", result);
});
