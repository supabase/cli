import { Effect, Option } from "effect";
import { pullMigrations } from "../../../../shared/migrations/pull-migrations.ts";
import { renderSchemaResult } from "../../../../shared/schema/schema-render.ts";
import type { MigrationsPullFlags } from "./pull.command.ts";

export const migrationsPull = Effect.fn("migrations.pull")(function* (flags: MigrationsPullFlags) {
  const result = yield* pullMigrations({
    from: Option.getOrUndefined(flags.from),
    name: Option.getOrUndefined(flags.name),
  });
  yield* renderSchemaResult("Pull remote migrations", result);
});
