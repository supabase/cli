import { Command } from "effect/cli";

import { sparkDbDiffCommand } from "./db/diff/diff.command.ts";
import { sparkDbPullCommand } from "./db/pull/pull.command.ts";
import { sparkDbPushCommand } from "./db/push/push.command.ts";
import { sparkDbQueryCommand } from "./db/query/query.command.ts";
import { sparkDbResetCommand } from "./db/reset/reset.command.ts";
import { sparkGenTypesCommand } from "./gen/types/types.command.ts";
import { sparkLinkCommand } from "./link/link.command.ts";
import { sparkMigrationListCommand } from "./migration/list/list.command.ts";

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
  Command.withSubcommands([sparkMigrationListCommand]),
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
