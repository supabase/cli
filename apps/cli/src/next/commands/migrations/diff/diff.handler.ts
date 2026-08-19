import { Effect, Option } from "effect";
import { diffMigrations } from "../../../../shared/migrations/diff-migrations.ts";
import { renderSchemaResult } from "../../../../shared/schema/schema-render.ts";
import type { MigrationsDiffFlags } from "./diff.command.ts";

export const migrationsDiff = Effect.fn("migrations.diff")(function* (flags: MigrationsDiffFlags) {
  const result = yield* diffMigrations({
    against: Option.getOrUndefined(flags.against),
    file: Option.getOrUndefined(flags.file),
  });
  yield* renderSchemaResult("Diff migrations", result);
});
