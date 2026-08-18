import { Command } from "effect/unstable/cli";
import { legacyWorkersNewCommand } from "./new/new.command.ts";

export const legacyWorkersCommand = Command.make("workers").pipe(
  Command.withDescription(
    "Manage Supabase Workers — containers that run your code next to your project, deployed from supabase/workers/<name>/.",
  ),
  Command.withShortDescription("Manage Supabase Workers"),
  Command.withSubcommands([legacyWorkersNewCommand]),
);
