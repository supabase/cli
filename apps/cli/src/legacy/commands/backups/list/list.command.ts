import { Command, Flag } from "effect/unstable/cli";
import { legacyBackupsList } from "./list.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
};

export const legacyBackupsListCommand = Command.make("list", config).pipe(
  Command.withDescription("Lists available physical backups for the linked project."),
  Command.withShortDescription("List available physical backups"),
  Command.withExamples([
    {
      command: "supabase backups list",
      description: "List all physical backups",
    },
    {
      command: "supabase backups list --project-ref <ref>",
      description: "List backups for a specific project",
    },
  ]),
  Command.withHandler((flags) => legacyBackupsList(flags)),
);
