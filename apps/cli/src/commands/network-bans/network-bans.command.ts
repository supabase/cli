import { Command } from "effect/unstable/cli";
import { networkBansGetCommand } from "./get/get.command.ts";
import { networkBansRemoveCommand } from "./remove/remove.command.ts";

export const networkBansCommand = Command.make("network-bans").pipe(
  Command.withDescription("Manage network bans."),
  Command.withShortDescription("Manage network bans"),
  Command.withSubcommands([networkBansGetCommand, networkBansRemoveCommand]),
);
