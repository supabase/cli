import { Command } from "effect/unstable/cli";
import { projectsListCommand } from "./list/list.command.ts";
import { projectsCreateCommand } from "./create/create.command.ts";
import { projectsApiKeysCommand } from "./api-keys/api-keys.command.ts";
import { projectsDeleteCommand } from "./delete/delete.command.ts";

export const projectsCommand = Command.make("projects").pipe(
  Command.withDescription("Manage Supabase projects."),
  Command.withShortDescription("Manage projects"),
  Command.withSubcommands([
    projectsListCommand,
    projectsCreateCommand,
    projectsApiKeysCommand,
    projectsDeleteCommand,
  ]),
);
