import { Effect, Option } from "effect";
import { pullMigrations } from "../../../../shared/migrations/pull-migrations.ts";
import { renderSchemaResult } from "../../../../shared/schema/schema-render.ts";
import type { LegacyMigrationsPullFlags } from "./pull.command.ts";

export const legacyMigrationsPull = Effect.fn("legacy.migrations.pull")(function* (
  flags: LegacyMigrationsPullFlags,
) {
  const result = yield* pullMigrations({
    from: Option.getOrUndefined(flags.from),
    name: Option.getOrUndefined(flags.name),
  });
  yield* renderSchemaResult("Pull remote migrations", result);
});
