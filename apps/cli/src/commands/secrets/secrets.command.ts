import { withSidebar } from "../../command-internal/command-sidebar.ts";
import { Command } from "effect/cli";
import { secretsListCommand } from "./list/list.command.ts";
import { secretsSetCommand } from "./set/set.command.ts";
import { secretsUnsetCommand } from "./unset/unset.command.ts";

export const secretsCommand = Command.make("secrets").pipe(
  withSidebar({ category: "secrets", title: "Manage secrets" }),
  Command.withDescription("Manage Supabase secrets."),
  Command.withShortDescription("Manage Supabase secrets"),
  Command.withSubcommands([secretsListCommand, secretsSetCommand, secretsUnsetCommand]),
);
