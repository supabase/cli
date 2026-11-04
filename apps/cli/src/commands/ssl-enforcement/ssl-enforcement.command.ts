import { Command } from "effect/cli";
import { sslEnforcementGetCommand } from "./get/get.command.ts";
import { sslEnforcementUpdateCommand } from "./update/update.command.ts";

export const sslEnforcementCommand = Command.make("ssl-enforcement").pipe(
  Command.withDescription("Control whether your project's database rejects connections that do not use SSL."),
  Command.withShortDescription("Manage SSL enforcement"),
  Command.withSubcommands([sslEnforcementGetCommand, sslEnforcementUpdateCommand]),
);
