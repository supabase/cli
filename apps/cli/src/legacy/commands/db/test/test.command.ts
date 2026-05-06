import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyDbTest } from "./test.handler.ts";

const config = {
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Tests the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Runs pgTAP tests on the linked project."),
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Runs pgTAP tests on the local database."),
  ),
  paths: Argument.string("path").pipe(
    Argument.withDescription("Paths to test files or directories."),
    Argument.variadic(),
  ),
} as const;

export type LegacyDbTestFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbTestCommand = Command.make("test", config).pipe(
  Command.withDescription("Tests local database with pgTAP."),
  Command.withShortDescription("Tests local database with pgTAP"),
  Command.withHandler((flags) => legacyDbTest(flags)),
);
