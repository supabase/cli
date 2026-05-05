import { Command } from "effect/unstable/cli";
import { functionsNewCommand } from "./new/new.command.ts";

export const functionsCommand = Command.make("functions").pipe(
  Command.withDescription("Manage Supabase Edge Functions."),
  Command.withShortDescription("Manage Supabase Edge Functions"),
  Command.withSubcommands([functionsNewCommand]),
);
