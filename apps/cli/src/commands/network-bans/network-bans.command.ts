import { withSidebar } from "../../command-internal/command-sidebar.ts";
import { Command } from "effect/cli";
import { networkBansGetCommand } from "./get/get.command.ts";
import { networkBansRemoveCommand } from "./remove/remove.command.ts";

export const networkBansCommand = Command.make("network-bans").pipe(
  withSidebar({ category: "network-bans" }),
  Command.withDescription("Manage network bans."),
  Command.withShortDescription("Manage network bans"),
  Command.withSubcommands([networkBansGetCommand, networkBansRemoveCommand]),
);
