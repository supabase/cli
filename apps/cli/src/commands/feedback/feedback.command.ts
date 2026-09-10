import { Command } from "effect/unstable/cli";
import { feedbackAddCommand } from "./add/add.command.ts";
import { feedbackDeleteCommand } from "./delete/delete.command.ts";

export const feedbackCommand = Command.make("feedback").pipe(
  Command.withDescription("Send feedback about the Supabase CLI to the Supabase team."),
  Command.withShortDescription("Send feedback to the Supabase team"),
  Command.withSubcommands([feedbackAddCommand, feedbackDeleteCommand]),
);
