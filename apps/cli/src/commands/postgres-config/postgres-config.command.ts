import { Command } from "effect/unstable/cli";
import { postgresConfigDeleteCommand } from "./delete/delete.command.ts";
import { postgresConfigGetCommand } from "./get/get.command.ts";
import { postgresConfigUpdateCommand } from "./update/update.command.ts";

export const postgresConfigCommand = Command.make("postgres-config").pipe(
  Command.withDescription("Manage Postgres database config."),
  Command.withShortDescription("Manage Postgres database config"),
  Command.withSubcommands([
    postgresConfigGetCommand,
    postgresConfigUpdateCommand,
    postgresConfigDeleteCommand,
  ]),
);
