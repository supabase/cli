import { Command } from "effect/unstable/cli";
import { legacyFunctionsListCommand } from "./list/list.command.ts";
import { legacyFunctionsDeleteCommand } from "./delete/delete.command.ts";
import { legacyFunctionsDownloadCommand } from "./download/download.command.ts";
import { legacyFunctionsDeployCommand } from "./deploy/deploy.command.ts";
import { legacyFunctionsNewCommand } from "./new/new.command.ts";
import { legacyFunctionsServeCommand } from "./serve/serve.command.ts";

export const legacyFunctionsCommand = Command.make("functions").pipe(
  Command.withDescription("Manage Supabase Edge functions."),
  Command.withShortDescription("Manage Supabase Edge functions"),
  Command.withSubcommands([
    legacyFunctionsListCommand,
    legacyFunctionsDeleteCommand,
    legacyFunctionsDownloadCommand,
    legacyFunctionsDeployCommand,
    legacyFunctionsNewCommand,
    legacyFunctionsServeCommand,
  ]),
);
