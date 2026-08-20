import { Effect, Option } from "effect";
import { diffMigrations } from "../../../../shared/migrations/diff-migrations.ts";
import { renderSchemaResult } from "../../../../shared/schema/schema-render.ts";
import type { LegacyMigrationsDiffFlags } from "./diff.command.ts";

export const legacyMigrationsDiff = Effect.fn("legacy.migrations.diff")(function* (
  flags: LegacyMigrationsDiffFlags,
) {
  const result = yield* diffMigrations({
    against: flags.against,
    file: Option.getOrUndefined(flags.file),
  });
  yield* renderSchemaResult("Diff migrations", result);
});
