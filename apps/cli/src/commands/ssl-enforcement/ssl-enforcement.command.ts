import { Command } from "effect/unstable/cli";
import { legacySslEnforcementGetCommand } from "./get/get.command.ts";
import { legacySslEnforcementUpdateCommand } from "./update/update.command.ts";

export const legacySslEnforcementCommand = Command.make("ssl-enforcement").pipe(
  Command.withDescription("Manage SSL enforcement configuration."),
  Command.withShortDescription("Manage SSL enforcement"),
  Command.withSubcommands([legacySslEnforcementGetCommand, legacySslEnforcementUpdateCommand]),
);
