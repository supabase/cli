import { Command } from "effect/unstable/cli";
import { legacyNetworkRestrictionsGetCommand } from "./get/get.command.ts";
import { legacyNetworkRestrictionsUpdateCommand } from "./update/update.command.ts";

export const legacyNetworkRestrictionsCommand = Command.make("network-restrictions").pipe(
  Command.withDescription("Manage network restrictions."),
  Command.withShortDescription("Manage network restrictions"),
  Command.withSubcommands([
    legacyNetworkRestrictionsGetCommand,
    legacyNetworkRestrictionsUpdateCommand,
  ]),
);
