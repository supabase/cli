import { Command, Flag } from "effect/unstable/cli";
import { legacyBackupsRestore } from "./restore.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  timestamp: Flag.integer("timestamp").pipe(
    Flag.withAlias("t"),
    Flag.withDescription("The recovery time target in seconds since epoch."),
    Flag.optional,
  ),
};

export const legacyBackupsRestoreCommand = Command.make("restore", config).pipe(
  Command.withDescription("Restore to a specific timestamp using Point-in-Time Recovery (PITR)."),
  Command.withShortDescription("Restore to a specific timestamp using PITR"),
  Command.withExamples([
    {
      command: "supabase backups restore --timestamp 1707407047",
      description: "Restore to the given Unix epoch timestamp",
    },
  ]),
  Command.withHandler((flags) => legacyBackupsRestore(flags)),
);
