import { withSidebar } from "../../command-internal/command-sidebar.ts";
import { Command } from "effect/cli";
import { feedbackAddCommand } from "./add/add.command.ts";
import { feedbackDeleteCommand } from "./delete/delete.command.ts";

export const feedbackCommand = Command.make("feedback").pipe(
  withSidebar({ category: "feedback" }),
  Command.withDescription("Send feedback about the Supabase CLI to the Supabase team."),
  Command.withShortDescription("Send feedback to the Supabase team"),
  Command.withSubcommands([feedbackAddCommand, feedbackDeleteCommand]),
);
