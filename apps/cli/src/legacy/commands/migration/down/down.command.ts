import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyMigrationDown } from "./down.handler.ts";

const config = {
  last: Flag.integer("last").pipe(
    Flag.withDescription("Reset up to the last n migration versions."),
    Flag.optional,
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Resets applied migrations on the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Resets applied migrations on the linked project."),
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Resets applied migrations on the local database."),
  ),
} as const;

export type LegacyMigrationDownFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyMigrationDownCommand = Command.make("down", config).pipe(
  Command.withDescription("Resets applied migrations up to the last n versions."),
  Command.withShortDescription("Resets applied migrations up to the last n versions"),
  Command.withHandler((flags) => legacyMigrationDown(flags)),
);
