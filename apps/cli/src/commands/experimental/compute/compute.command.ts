import { Command } from "effect/unstable/cli";
import { computeDeleteCommand } from "./delete/delete.command.ts";
import { computeListCommand } from "./list/list.command.ts";
import { computeLogsCommand } from "./logs/logs.command.ts";
import { computeNewCommand } from "./new/new.command.ts";
import { computePushCommand } from "./push/push.command.ts";
import { computeStatusCommand } from "./status/status.command.ts";

export const computeCommand = Command.make("compute").pipe(
  Command.withDescription(
    "Manage Supabase Compute: containers that run your code next to your project, deployed from supabase/compute/<name>/.",
  ),
  Command.withShortDescription("Manage Supabase Compute"),
  Command.withSubcommands([
    computeNewCommand,
    computePushCommand,
    computeListCommand,
    computeStatusCommand,
    computeLogsCommand,
    computeDeleteCommand,
  ]),
);
