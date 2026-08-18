import { Command } from "effect/unstable/cli";
import { workersListCommand } from "./list/list.command.ts";
import { workersNewCommand } from "./new/new.command.ts";
import { workersPushCommand } from "./push/push.command.ts";

export const workersCommand = Command.make("workers").pipe(
  Command.withDescription(
    "Manage Supabase Workers — containers that run your code next to your project, deployed from supabase/workers/<name>/.",
  ),
  Command.withShortDescription("Manage Supabase Workers"),
  Command.withSubcommands([workersNewCommand, workersPushCommand, workersListCommand]),
);
