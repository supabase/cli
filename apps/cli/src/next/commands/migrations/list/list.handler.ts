import { Effect, Option } from "effect";
import { listMigrations } from "../../../../shared/migrations/list-migrations.ts";
import { renderSchemaResult } from "../../../../shared/schema/schema-render.ts";
import type { MigrationsListFlags } from "./list.command.ts";

export const migrationsList = Effect.fn("migrations.list")(function* (flags: MigrationsListFlags) {
  const result = yield* listMigrations({ against: Option.getOrUndefined(flags.against) });
  yield* renderSchemaResult("List migrations", result);
});
