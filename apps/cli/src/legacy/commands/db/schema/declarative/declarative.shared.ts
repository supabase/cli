import { Command, Flag } from "effect/unstable/cli";

/**
 * Base `db schema declarative` group command carrying the shared `--no-cache`
 * flag. Go registers `--no-cache` as a persistent flag on the group
 * (`apps/cli-go/cmd/db_schema_declarative.go:480-481`), so it is accepted both
 * before and after the `generate`/`sync` subcommand name. Subcommand handlers read
 * the resolved value via `yield* legacyDbSchemaDeclarativeSharedBase` — its context
 * tag is stable across `withSubcommands`, so this base (defined without subcommands
 * to avoid an import cycle) is the one the leaves import.
 */
export const legacyDbSchemaDeclarativeSharedBase = Command.make("declarative").pipe(
  Command.withDescription("Manage declarative database schemas."),
  Command.withShortDescription("Manage declarative database schemas"),
  Command.withSharedFlags({
    noCache: Flag.boolean("no-cache").pipe(
      Flag.withDescription("Disable catalog cache and force fresh shadow database setup."),
    ),
  }),
);
