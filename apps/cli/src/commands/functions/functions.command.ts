import { Command } from "effect/cli";
import { functionsListCommand } from "./list/list.command.ts";
import { functionsDeleteCommand } from "./delete/delete.command.ts";
import { functionsDownloadCommand } from "./download/download.command.ts";
import { functionsDeployCommand } from "./deploy/deploy.command.ts";
import { functionsNewCommand } from "./new/new.command.ts";
import { functionsServeCommand } from "./serve/serve.command.ts";

export const functionsCommand = Command.make("functions").pipe(
  Command.withDescription(
    "Create, serve, deploy and delete Edge Functions, the server-side TypeScript functions that run on the Supabase edge runtime.",
  ),
  Command.withShortDescription("Manage Edge Functions"),
  Command.withSubcommands([
    functionsListCommand,
    functionsDeleteCommand,
    functionsDownloadCommand,
    functionsDeployCommand,
    functionsNewCommand,
    functionsServeCommand,
  ]),
);
