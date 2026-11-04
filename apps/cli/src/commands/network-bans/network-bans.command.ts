import { Command } from "effect/cli";
import { networkBansGetCommand } from "./get/get.command.ts";
import { networkBansRemoveCommand } from "./remove/remove.command.ts";

export const networkBansCommand = Command.make("network-bans").pipe(
  Command.withDescription(
    "View and lift temporary bans on IP addresses blocked for abusive traffic.",
  ),
  Command.withShortDescription("Manage network bans"),
  Command.withSubcommands([networkBansGetCommand, networkBansRemoveCommand]),
);
