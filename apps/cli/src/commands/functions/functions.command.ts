import { Command } from "effect/unstable/cli";
import { functionsListCommand } from "./list/list.command.ts";
import { functionsDeleteCommand } from "./delete/delete.command.ts";
import { functionsDownloadCommand } from "./download/download.command.ts";
import { functionsDeployCommand } from "./deploy/deploy.command.ts";
import { functionsNewCommand } from "./new/new.command.ts";
import { functionsServeCommand } from "./serve/serve.command.ts";
import { functionsServeStackCommand } from "../experimental/stack/functions/serve/serve.command.ts";
import type { StackBackend } from "../experimental/stack/stack-backend.ts";

export const functionsCommandForBackend = (backend: StackBackend = "legacy") =>
  Command.make("functions").pipe(
  Command.withDescription("Manage Supabase Edge functions."),
  Command.withShortDescription("Manage Supabase Edge functions"),
  Command.withSubcommands([
    functionsListCommand,
    functionsDeleteCommand,
    functionsDownloadCommand,
    functionsDeployCommand,
    functionsNewCommand,
    backend === "stack" ? functionsServeStackCommand : functionsServeCommand,
  ]),
);

export const functionsCommand = functionsCommandForBackend();
