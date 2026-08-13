import { Command } from "effect/unstable/cli";
import { legacyFeedbackAddCommand } from "./add/add.command.ts";

export const legacyFeedbackCommand = Command.make("feedback").pipe(
  Command.withDescription("Send feedback about the Supabase CLI to the Supabase team."),
  Command.withShortDescription("Send feedback to the Supabase team"),
  Command.withSubcommands([legacyFeedbackAddCommand]),
);
