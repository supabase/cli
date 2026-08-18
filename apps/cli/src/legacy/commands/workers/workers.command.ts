import { Command } from "effect/unstable/cli";
import { legacyWorkersDeleteCommand } from "./delete/delete.command.ts";
import { legacyWorkersListCommand } from "./list/list.command.ts";
import { legacyWorkersNewCommand } from "./new/new.command.ts";
import { legacyWorkersPushCommand } from "./push/push.command.ts";
import { legacyWorkersStatusCommand } from "./status/status.command.ts";

export const legacyWorkersCommand = Command.make("workers").pipe(
  Command.withDescription(
    "Manage Supabase Workers — containers that run your code next to your project, deployed from supabase/workers/<name>/.",
  ),
  Command.withShortDescription("Manage Supabase Workers"),
  Command.withSubcommands([
    legacyWorkersNewCommand,
    legacyWorkersPushCommand,
    legacyWorkersListCommand,
    legacyWorkersStatusCommand,
    legacyWorkersDeleteCommand,
  ]),
);
