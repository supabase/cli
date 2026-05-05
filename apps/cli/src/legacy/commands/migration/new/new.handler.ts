import { Effect } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyMigrationNewFlags } from "./new.command.ts";

export const legacyMigrationNew = Effect.fn("legacy.migration.new")(function* (
  flags: LegacyMigrationNewFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["migration", "new", flags.migrationName];
  yield* proxy.exec(args);
});
