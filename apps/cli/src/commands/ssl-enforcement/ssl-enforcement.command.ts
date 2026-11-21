import { withSidebar } from "../../command-internal/command-sidebar.ts";
import { Command } from "effect/cli";
import { sslEnforcementGetCommand } from "./get/get.command.ts";
import { sslEnforcementUpdateCommand } from "./update/update.command.ts";

export const sslEnforcementCommand = Command.make("ssl-enforcement").pipe(
  withSidebar({ category: "ssl-enforcement", title: "Manage SSL enforcement configurations" }),
  Command.withDescription("Manage SSL enforcement configuration."),
  Command.withShortDescription("Manage SSL enforcement"),
  Command.withSubcommands([sslEnforcementGetCommand, sslEnforcementUpdateCommand]),
);
