import { Effect, Option } from "effect";
import { pushMigrations } from "../../../../shared/migrations/push-migrations.ts";
import { renderSchemaResult } from "../../../../shared/schema/schema-render.ts";
import type { LegacyMigrationsPushFlags } from "./push.command.ts";

export const legacyMigrationsPush = Effect.fn("legacy.migrations.push")(function* (
  flags: LegacyMigrationsPushFlags,
) {
  const result = yield* pushMigrations({
    yes: flags.yes,
    projectRef: Option.getOrUndefined(flags.projectRef),
    allowRemote: flags.allowRemote,
    dbUrl: Option.getOrUndefined(flags.dbUrl),
    skipVerify: flags.skipVerify,
  });
  yield* renderSchemaResult("Push migrations", result);
});
