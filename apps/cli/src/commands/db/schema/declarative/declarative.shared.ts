import { Command, Flag } from "effect/cli";
import { cliFlag, withSharedParams } from "../../../../shared/cli/cli-params.ts";

/**
 * Base `db schema declarative` group command carrying the shared `--no-cache`/`--strict-coverage`
 * flags, accepted both before and after the `generate`/`sync` subcommand name. Defined without
 * subcommands to avoid an import cycle; leaf handlers import this base directly.
 */
export const dbSchemaDeclarativeSharedBase = Command.make("declarative").pipe(
  Command.withDescription(
    "Keep your schema as a tree of SQL files and generate migrations from the difference to your applied migrations.",
  ),
  Command.withShortDescription("Manage declarative database schemas"),
  withSharedParams({
    noCache: cliFlag("no-cache", Flag.Boolean, {
      description: "Disable the catalog cache and force a fresh shadow database setup.",
      default: false,
    }),
    strictCoverage: cliFlag("strict-coverage", Flag.Boolean, {
      description:
        "Fail when pg-delta finds schema objects it cannot manage, instead of leaving them unmanaged.",
      default: false,
    }),
  }),
);
