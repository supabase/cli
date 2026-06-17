import { Command } from "effect/unstable/cli";
import { functionsDevCommand } from "./dev/dev.command.ts";
import { functionsDeleteCommand } from "./delete/delete.command.ts";
import { functionsDeployCommand } from "./deploy/deploy.command.ts";
import { functionsDownloadCommand } from "./download/download.command.ts";
import { functionsListCommand } from "./list/list.command.ts";
import { functionsNewCommand } from "./new/new.command.ts";

export const functionsCommand = Command.make("functions").pipe(
  Command.withDescription("Manage Supabase Edge Functions."),
  Command.withShortDescription("Manage Supabase Edge Functions"),
  Command.withSubcommands([
    functionsListCommand,
    functionsDeleteCommand,
    functionsDeployCommand,
    functionsDownloadCommand,
    functionsNewCommand,
    functionsDevCommand,
  ]),
);
