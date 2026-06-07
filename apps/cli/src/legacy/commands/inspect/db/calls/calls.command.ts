import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInspectDbCalls } from "./calls.handler.ts";

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

export type LegacyInspectDbCallsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInspectDbCallsCommand = Command.make("calls", config).pipe(
  Command.withDescription("Show queries from pg_stat_statements ordered by total times called."),
  Command.withShortDescription("Show queries by call count"),
  Command.withHandler((flags) => legacyInspectDbCalls(flags)),
);
