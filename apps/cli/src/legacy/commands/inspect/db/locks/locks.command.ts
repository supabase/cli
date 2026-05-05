import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInspectDbLocks } from "./locks.handler.ts";

const config = {
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Inspect the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(Flag.withDescription("Inspect the linked project.")),
  local: Flag.boolean("local").pipe(Flag.withDescription("Inspect the local database.")),
} as const;

export type LegacyInspectDbLocksFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInspectDbLocksCommand = Command.make("locks", config).pipe(
  Command.withDescription("Show queries which have taken out an exclusive lock on a relation."),
  Command.withShortDescription("Show exclusive locks"),
  Command.withHandler((flags) => legacyInspectDbLocks(flags)),
);
