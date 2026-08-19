import { Argument, Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandInstrumentation } from "../../../../shared/telemetry/command-instrumentation.ts";
import { schemaRuntimeLayer } from "../../../../shared/schema/schema-runtime.layer.ts";
import { migrationsNew } from "./new.handler.ts";

const args = {
  name: Argument.string("name").pipe(
    Argument.withDescription("Migration name."),
    Argument.optional,
  ),
} as const;

export type MigrationsNewFlags = CliCommand.Command.Config.Infer<typeof args>;

export const migrationsNewCommand = Command.make("new", args).pipe(
  Command.withDescription("Create an empty migration file for manual authoring."),
  Command.withShortDescription("Create an empty migration"),
  Command.withExamples([
    {
      command: "supabase migrations new add_custom_data",
      description: "Create supabase/migrations/<timestamp>_add_custom_data.sql",
    },
  ]),
  Command.withHandler((flags) =>
    migrationsNew(flags).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(schemaRuntimeLayer(["migrations", "new"])),
);
