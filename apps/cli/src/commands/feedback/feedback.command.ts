import { Command } from "effect/cli";
import { feedbackAddCommand } from "./add/add.command.ts";
import { feedbackDeleteCommand } from "./delete/delete.command.ts";

export const feedbackCommand = Command.make("feedback").pipe(
  Command.withDescription(
    "Tell the Supabase team what works and what does not in the CLI, or delete feedback you sent earlier using its deletion token.",
  ),
  Command.withShortDescription("Send or delete CLI feedback"),
  Command.withSubcommands([feedbackAddCommand, feedbackDeleteCommand]),
);
