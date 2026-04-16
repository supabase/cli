import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyDbAdvisors } from "./advisors.handler.ts";

const config = {
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Checks the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Checks the linked project for issues."),
  ),
  local: Flag.boolean("local").pipe(Flag.withDescription("Checks the local database for issues.")),
  type: Flag.choice("type", ["all", "security", "performance"] as const).pipe(
    Flag.withDescription("Type of advisors to check: all, security, performance."),
    Flag.optional,
  ),
  level: Flag.choice("level", ["info", "warn", "error"] as const).pipe(
    Flag.withDescription("Minimum issue level to display: info, warn, error."),
    Flag.optional,
  ),
  failOn: Flag.choice("fail-on", ["none", "info", "warn", "error"] as const).pipe(
    Flag.withDescription("Issue level to exit with non-zero status: none, info, warn, error."),
    Flag.optional,
  ),
} as const;

export type LegacyDbAdvisorsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbAdvisorsCommand = Command.make("advisors", config).pipe(
  Command.withDescription("Checks database for security and performance issues."),
  Command.withShortDescription("Checks database for security and performance issues"),
  Command.withHandler((flags) => legacyDbAdvisors(flags)),
);
