import { Command } from "effect/unstable/cli";
import { functionsListCommand } from "./list/list.command.ts";
import { functionsDeleteCommand } from "./delete/delete.command.ts";
import { functionsDownloadCommand } from "./download/download.command.ts";
import { functionsDeployCommand } from "./deploy/deploy.command.ts";
import { functionsNewCommand } from "./new/new.command.ts";
import { functionsServeCommand } from "./serve/serve.command.ts";

export const functionsCommandWithServe = <Input, ContextInput, E, R>(
  serveCommand: Command.Command<"serve", Input, ContextInput, E, R>,
) =>
  Command.make("functions").pipe(
    Command.withDescription("Manage Supabase Edge functions."),
    Command.withShortDescription("Manage Supabase Edge functions"),
    Command.withSubcommands([
      functionsListCommand,
      functionsDeleteCommand,
      functionsDownloadCommand,
      functionsDeployCommand,
      functionsNewCommand,
      serveCommand,
    ]),
  );

export const functionsCommand = functionsCommandWithServe(functionsServeCommand);
