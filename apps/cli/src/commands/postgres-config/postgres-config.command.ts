import { withSidebar } from "../../command-internal/command-sidebar.ts";
import { Command } from "effect/cli";
import { postgresConfigDeleteCommand } from "./delete/delete.command.ts";
import { postgresConfigGetCommand } from "./get/get.command.ts";
import { postgresConfigUpdateCommand } from "./update/update.command.ts";

export const postgresConfigCommand = Command.make("postgres-config").pipe(
  withSidebar({ category: "postgres-config", title: "Manage Postgres configurations" }),
  Command.withDescription("Manage Postgres database config."),
  Command.withShortDescription("Manage Postgres database config"),
  Command.withSubcommands([
    postgresConfigGetCommand,
    postgresConfigUpdateCommand,
    postgresConfigDeleteCommand,
  ]),
);
