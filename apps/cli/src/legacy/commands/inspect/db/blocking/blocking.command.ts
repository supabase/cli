import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInspectDbBlocking } from "./blocking.handler.ts";

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

export type LegacyInspectDbBlockingFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInspectDbBlockingCommand = Command.make("blocking", config).pipe(
  Command.withDescription(
    "Show queries that are holding locks and the queries that are waiting for them to be released.",
  ),
  Command.withShortDescription("Show blocking queries"),
  Command.withHandler((flags) => legacyInspectDbBlocking(flags)),
);
