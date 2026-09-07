import { Command } from "effect/unstable/cli";
import { legacyPostgresConfigDeleteCommand } from "./delete/delete.command.ts";
import { legacyPostgresConfigGetCommand } from "./get/get.command.ts";
import { legacyPostgresConfigUpdateCommand } from "./update/update.command.ts";

export const legacyPostgresConfigCommand = Command.make("postgres-config").pipe(
  Command.withDescription("Manage Postgres database config."),
  Command.withShortDescription("Manage Postgres database config"),
  Command.withSubcommands([
    legacyPostgresConfigGetCommand,
    legacyPostgresConfigUpdateCommand,
    legacyPostgresConfigDeleteCommand,
  ]),
);
