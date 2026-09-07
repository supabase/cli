import { Command } from "effect/unstable/cli";
import { legacyNetworkBansGetCommand } from "./get/get.command.ts";
import { legacyNetworkBansRemoveCommand } from "./remove/remove.command.ts";

export const legacyNetworkBansCommand = Command.make("network-bans").pipe(
  Command.withDescription("Manage network bans."),
  Command.withShortDescription("Manage network bans"),
  Command.withSubcommands([legacyNetworkBansGetCommand, legacyNetworkBansRemoveCommand]),
);
