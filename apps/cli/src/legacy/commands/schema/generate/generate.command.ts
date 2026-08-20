import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacySchemaRuntimeLayer } from "../../../schema/legacy-schema-runtime.layer.ts";
import { legacySchemaGenerate } from "./generate.handler.ts";

const config = {
  name: Flag.string("name").pipe(
    Flag.withDescription("Name for the generated migration files."),
    Flag.optional,
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("Show the plan without writing migration files."),
  ),
  baseline: Flag.boolean("baseline").pipe(
    Flag.withDescription(
      "Write the first migration from supabase/schemas. Refuses if migration files already exist. Use schema pull first if a live database is the source.",
    ),
  ),
} as const;

export type LegacySchemaGenerateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacySchemaGenerateCommand = Command.make("generate", config).pipe(
  Command.withDescription(
    "Turn supabase/schemas into migration files.\n\n" +
      "Compares a clean replay of supabase/migrations to supabase/schemas. Does not apply anything to a live database.\n\n" +
      "--dry-run shows the same plan without writing files. --baseline writes the first migration from supabase/schemas when supabase/migrations is empty.",
  ),
  Command.withShortDescription("Write migrations from supabase/schemas"),
  Command.withExamples([
    {
      command: "supabase schema generate --dry-run",
      description: "Preview the migration without writing files",
    },
    {
      command: "supabase schema generate --name add_billing",
      description: "Write the migration files",
    },
    {
      command: "supabase schema generate --baseline --name initial_schema",
      description: "Write the first migration from supabase/schemas",
    },
  ]),
  Command.withHandler((flags) =>
    legacySchemaGenerate(flags).pipe(
      withLegacyCommandInstrumentation({ flags, config }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacySchemaRuntimeLayer(["schema", "generate"])),
);
