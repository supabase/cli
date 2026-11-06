import { Command } from "effect/cli";
import { secretsListCommand } from "./list/list.command.ts";
import { secretsSetCommand } from "./set/set.command.ts";
import { secretsUnsetCommand } from "./unset/unset.command.ts";

export const secretsCommand = Command.make("secrets").pipe(
  Command.withDescription(
    "Set, unset and list the secrets that Edge Functions read as environment variables.",
  ),
  Command.withShortDescription("Manage Edge Function secrets"),
  Command.withSubcommands([secretsListCommand, secretsSetCommand, secretsUnsetCommand]),
);
