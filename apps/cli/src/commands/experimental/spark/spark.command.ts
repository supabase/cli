import { Layer } from "effect";
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
import { SparkDevInstanceMode } from "./spark-dev-instance.ts";
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

/** The commands a Spark project's tree adds to `init` and the local stack harness. */
export const sparkCommands = [
  sparkLinkCommand,
  sparkDbCommand,
  sparkMigrationCommand,
  sparkGenCommand,
] as const;

const devInstanceMode = Layer.succeed(SparkDevInstanceMode, true);

/**
 * The Spark commands of a dev-instance project (`[experimental.spark] dev_instance`): `start`,
 * `status` and `stop` act on the dev instance, and the others target it by default.
 */
export const sparkDevInstanceCommands = [
  sparkDevStartCommand,
  sparkDevStatusCommand,
  sparkDevStopCommand,
  sparkLinkCommand,
  sparkDbCommand.pipe(Command.provide(devInstanceMode)),
  sparkMigrationCommand.pipe(Command.provide(devInstanceMode)),
  sparkGenCommand.pipe(Command.provide(devInstanceMode)),
] as const;
