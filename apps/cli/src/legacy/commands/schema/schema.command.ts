import { Command } from "effect/unstable/cli";
import { legacySchemaApplyCommand } from "./apply/apply.command.ts";
import { legacySchemaGenerateCommand } from "./generate/generate.command.ts";
import { legacySchemaPullCommand } from "./pull/pull.command.ts";

export const legacySchemaCommand = Command.make("schema").pipe(
  Command.withDescription(
    "Edit database shape as SQL in supabase/schemas.\n\n" +
      "Typical loop:\n" +
      "  schema pull       Capture a database into supabase/schemas\n" +
      "  schema apply      Try declaration edits on the local database\n" +
      "  schema generate   Write a reviewable migration when the shape is right\n\n" +
      "schema apply never touches a remote. Deploy remotes with migrations push.",
  ),
  Command.withShortDescription("Edit database shape in supabase/schemas"),
  Command.withSubcommands([
    legacySchemaPullCommand,
    legacySchemaGenerateCommand,
    legacySchemaApplyCommand,
  ]),
);
