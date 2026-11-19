import { withSidebar } from "../../command-internal/command-sidebar.ts";
import { Command } from "effect/cli";
import { networkRestrictionsGetCommand } from "./get/get.command.ts";
import { networkRestrictionsUpdateCommand } from "./update/update.command.ts";

export const networkRestrictionsCommand = Command.make("network-restrictions").pipe(
  withSidebar({ category: "network-restrictions" }),
  Command.withDescription("Manage network restrictions."),
  Command.withShortDescription("Manage network restrictions"),
  Command.withSubcommands([networkRestrictionsGetCommand, networkRestrictionsUpdateCommand]),
);
