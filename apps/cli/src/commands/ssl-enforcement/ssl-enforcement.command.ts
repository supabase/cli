import { Command } from "effect/unstable/cli";
import { sslEnforcementGetCommand } from "./get/get.command.ts";
import { sslEnforcementUpdateCommand } from "./update/update.command.ts";

export const sslEnforcementCommand = Command.make("ssl-enforcement").pipe(
  Command.withDescription("Manage SSL enforcement configuration."),
  Command.withShortDescription("Manage SSL enforcement"),
  Command.withSubcommands([sslEnforcementGetCommand, sslEnforcementUpdateCommand]),
);
