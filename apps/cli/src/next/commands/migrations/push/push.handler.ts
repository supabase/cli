import { Effect, Option } from "effect";
import { pushMigrations } from "../../../../shared/migrations/push-migrations.ts";
import { renderSchemaResult } from "../../../../shared/schema/schema-render.ts";
import type { MigrationsPushFlags } from "./push.command.ts";

export const migrationsPush = Effect.fn("migrations.push")(function* (flags: MigrationsPushFlags) {
  const result = yield* pushMigrations({
    yes: flags.yes,
    allowDataLoss: flags.allowDataLoss,
    projectRef: Option.getOrUndefined(flags.projectRef),
    allowRemote: flags.allowRemote,
    dbUrl: Option.getOrUndefined(flags.dbUrl),
  });
  yield* renderSchemaResult("Push migrations", result);
});
