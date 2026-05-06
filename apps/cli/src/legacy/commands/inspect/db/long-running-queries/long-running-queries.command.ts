import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInspectDbLongRunningQueries } from "./long-running-queries.handler.ts";

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

export type LegacyInspectDbLongRunningQueriesFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInspectDbLongRunningQueriesCommand = Command.make(
  "long-running-queries",
  config,
).pipe(
  Command.withDescription("Show currently running queries running for longer than 5 minutes."),
  Command.withShortDescription("Show long-running queries"),
  Command.withHandler((flags) => legacyInspectDbLongRunningQueries(flags)),
);
