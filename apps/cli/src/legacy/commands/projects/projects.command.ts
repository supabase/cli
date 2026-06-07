import { Command } from "effect/unstable/cli";
import { legacyProjectsListCommand } from "./list/list.command.ts";
import { legacyProjectsCreateCommand } from "./create/create.command.ts";
import { legacyProjectsApiKeysCommand } from "./api-keys/api-keys.command.ts";
import { legacyProjectsDeleteCommand } from "./delete/delete.command.ts";

export const legacyProjectsCommand = Command.make("projects").pipe(
  Command.withDescription("Manage Supabase projects."),
  Command.withShortDescription("Manage projects"),
  Command.withSubcommands([
    legacyProjectsListCommand,
    legacyProjectsCreateCommand,
    legacyProjectsApiKeysCommand,
    legacyProjectsDeleteCommand,
  ]),
);
