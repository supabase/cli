import { Command, Flag } from "effect/unstable/cli";

/**
 * Base `db schema declarative` group command carrying the shared `--no-cache`/`--strict-coverage`
 * flags, accepted both before and after the `generate`/`sync` subcommand name. Defined without
 * subcommands to avoid an import cycle; leaf handlers import this base directly.
 */
export const dbSchemaDeclarativeSharedBase = Command.make("declarative").pipe(
  Command.withDescription("Manage declarative database schemas."),
  Command.withShortDescription("Manage declarative database schemas"),
  Command.withSharedFlags({
    noCache: Flag.boolean("no-cache").pipe(
      Flag.withDescription("Disable catalog cache and force fresh shadow database setup."),
      Flag.withDefault(false),
    ),
    strictCoverage: Flag.boolean("strict-coverage").pipe(
      Flag.withDescription(
        "Fail when bundled pg-delta finds schema objects it cannot manage instead of leaving them unmanaged.",
      ),
      Flag.withDefault(false),
    ),
  }),
);
