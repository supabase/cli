import { Command } from "effect/unstable/cli";
import { networkRestrictionsGetCommand } from "./get/get.command.ts";
import { networkRestrictionsUpdateCommand } from "./update/update.command.ts";

export const networkRestrictionsCommand = Command.make("network-restrictions").pipe(
  Command.withDescription("Manage network restrictions."),
  Command.withShortDescription("Manage network restrictions"),
  Command.withSubcommands([networkRestrictionsGetCommand, networkRestrictionsUpdateCommand]),
);
