import { Command } from "effect/cli";

import { sparkDbDiffCommand } from "./db/diff/diff.command.ts";
import { sparkDbPullCommand } from "./db/pull/pull.command.ts";
import { sparkDbPushCommand } from "./db/push/push.command.ts";
import { sparkDbQueryCommand } from "./db/query/query.command.ts";
import { sparkDbResetCommand } from "./db/reset/reset.command.ts";
import { sparkGenTypesCommand } from "./gen/types/types.command.ts";
import { sparkLinkCommand } from "./link/link.command.ts";
import { sparkMigrationFetchCommand } from "./migration/fetch/fetch.command.ts";
import { sparkMigrationListCommand } from "./migration/list/list.command.ts";
import type { ProjectTargetFlagValues } from "../../../command-internal/target/target-flags.ts";
import { devInstanceDefaultProjectLayer, devInstanceHostedLayer } from "./spark-dev-instance.ts";
import { sparkDevStartCommand } from "./start/start.command.ts";
import { sparkDevStatusCommand } from "./status/status.command.ts";
import { sparkDevStopCommand } from "./stop/stop.command.ts";

const sparkDbCommand = Command.make("db").pipe(
  Command.withDescription("Manage the Spark project's database schema and migrations."),
  Command.withShortDescription("Manage databases"),
  Command.withSubcommands([
    sparkDbDiffCommand,
    sparkDbPullCommand,
    sparkDbPushCommand,
    sparkDbQueryCommand,
    sparkDbResetCommand,
  ]),
);

const sparkMigrationCommand = Command.make("migration").pipe(
  Command.withDescription("Manage database migration scripts."),
  Command.withShortDescription("Manage database migration scripts"),
  Command.withAlias("migrations"),
  Command.withSubcommands([sparkMigrationFetchCommand, sparkMigrationListCommand]),
);

const sparkGenCommand = Command.make("gen").pipe(
  Command.withDescription("Run code generation tools."),
  Command.withShortDescription("Run code generation tools"),
  Command.withSubcommands([sparkGenTypesCommand]),
);

/**
 * The Spark commands of a Spark project's tree: `start`, `status` and `stop` manage the checkout's
 * dev instance, and the others target it by default.
 */
export const sparkCommands = [
  sparkDevStartCommand,
  sparkDevStatusCommand,
  sparkDevStopCommand,
  sparkLinkCommand,
  sparkDbCommand,
  sparkMigrationCommand,
  sparkGenCommand,
] as const;

/**
 * A mainline command with no project flags (`projects list`) mounted in the Spark tree: its
 * soft project lookup finds the dev instance when the checkout has one, so no "not linked"
 * warning is printed and the instance's row is the marked one.
 */
export const withSparkDevInstanceDefault = <const Name extends string, Input, ContextInput, E, R>(
  command: Command.Command<Name, Input, ContextInput, E, R>,
) => command.pipe(Command.provide(devInstanceDefaultProjectLayer));

interface DevInstanceHelp {
  readonly description: string;
  readonly examples?: ReadonlyArray<{ readonly command: string; readonly description: string }>;
}

/**
 * A mainline hosted command (`functions`, `secrets`) mounted in the Spark tree: with no
 * `--project-ref` or `--remote` it acts on the dev instance, and `functions deploy` uploads
 * through the API. `help` replaces the mainline description, which says "linked project".
 */
export const withSparkDevInstanceProject = <
  const Name extends string,
  Input extends ProjectTargetFlagValues,
  ContextInput,
  E,
  R,
>(
  command: Command.Command<Name, Input, ContextInput, E, R>,
  help: DevInstanceHelp,
) =>
  command.pipe(
    Command.withDescription(help.description),
    (described) =>
      help.examples === undefined ? described : described.pipe(Command.withExamples(help.examples)),
    Command.provide((flags: Input) => devInstanceHostedLayer(flags)),
  );
