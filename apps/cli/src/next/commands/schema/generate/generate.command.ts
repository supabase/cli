import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandInstrumentation } from "../../../../shared/telemetry/command-instrumentation.ts";
import { schemaRuntimeLayer } from "../../../../shared/schema/schema-runtime.layer.ts";
import { schemaGenerate } from "./generate.handler.ts";

const flags = {
  name: Flag.string("name").pipe(
    Flag.withDescription("Name for the generated migration change set."),
    Flag.optional,
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("Preview the plan without writing migration files."),
  ),
  baseline: Flag.boolean("baseline").pipe(
    Flag.withDescription(
      "Generate a baseline migration from an empty replay (existing-database onboarding). Refuses if migration files already exist.",
    ),
  ),
} as const;

export type SchemaGenerateFlags = CliCommand.Command.Config.Infer<typeof flags>;

export const schemaGenerateCommand = Command.make("generate", flags).pipe(
  Command.withDescription(
    "Compile declarative schema changes into verified migration files.\n\n" +
      "Always plans from a clean migration replay to the declarations. " +
      "--dry-run runs the same pipeline and writes nothing.",
  ),
  Command.withShortDescription("Generate migrations from supabase/schemas"),
  Command.withExamples([
    { command: "supabase schema generate --dry-run", description: "Preview the generate plan" },
    {
      command: "supabase schema generate --name add_billing",
      description: "Write the migration change set",
    },
    {
      command: "supabase schema generate --baseline --name initial_schema",
      description: "Create a baseline migration for an existing database",
    },
  ]),
  Command.withHandler((commandFlags) =>
    schemaGenerate(commandFlags).pipe(
      withCommandInstrumentation({ flags: commandFlags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(schemaRuntimeLayer(["schema", "generate"])),
);
