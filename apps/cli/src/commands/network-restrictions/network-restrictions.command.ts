import { Command } from "effect/cli";
import { networkRestrictionsGetCommand } from "./get/get.command.ts";
import { networkRestrictionsUpdateCommand } from "./update/update.command.ts";

export const networkRestrictionsCommand = Command.make("network-restrictions").pipe(
  Command.withDescription("Limit which IP ranges can connect directly to your project's database."),
  Command.withShortDescription("Manage network restrictions"),
  Command.withSubcommands([networkRestrictionsGetCommand, networkRestrictionsUpdateCommand]),
);
