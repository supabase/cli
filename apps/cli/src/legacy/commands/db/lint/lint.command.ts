import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyDbLint } from "./lint.handler.ts";

const config = {
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Lints the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Lints the linked project for schema errors."),
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Lints the local database for schema errors."),
  ),
  schema: Flag.string("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
  ),
  level: Flag.choice("level", ["warning", "error"] as const).pipe(
    Flag.withDescription("Error level to emit."),
    Flag.optional,
  ),
  failOn: Flag.choice("fail-on", ["none", "warning", "error"] as const).pipe(
    Flag.withDescription("Error level to exit with non-zero status."),
    Flag.optional,
  ),
} as const;

export type LegacyDbLintFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbLintCommand = Command.make("lint", config).pipe(
  Command.withDescription("Checks local database for typing error."),
  Command.withShortDescription("Checks local database for typing error"),
  Command.withHandler((flags) => legacyDbLint(flags)),
);
