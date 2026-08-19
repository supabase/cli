import { Command } from "effect/unstable/cli";
import { SCHEMA_ECOSYSTEM_MAPPING_HELP } from "../../../shared/schema/schema-ecosystem.ts";
import { schemaApplyCommand } from "./apply/apply.command.ts";
import { schemaGenerateCommand } from "./generate/generate.command.ts";
import { schemaPullCommand } from "./pull/pull.command.ts";

export const schemaCommand = Command.make("schema").pipe(
  Command.withDescription(
    "Manage database shape from declarative SQL in supabase/schemas.\n\n" +
      "schema apply is the local edit/test loop. schema generate writes reviewable migrations. " +
      "Durable remotes change only through migrations push.\n\n" +
      SCHEMA_ECOSYSTEM_MAPPING_HELP,
  ),
  Command.withShortDescription("Declarative database schema workflow"),
  Command.withSubcommands([schemaPullCommand, schemaGenerateCommand, schemaApplyCommand]),
);
