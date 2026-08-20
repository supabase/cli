import { Argument, Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacySchemaRuntimeLayer } from "../../../schema/legacy-schema-runtime.layer.ts";
import { legacyMigrationsNew } from "./new.handler.ts";

const config = {
  name: Argument.string("name").pipe(
    Argument.withDescription("Migration name."),
    Argument.optional,
  ),
} as const;

export type LegacyMigrationsNewFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyMigrationsNewCommand = Command.make("new", config).pipe(
  Command.withDescription(
    "Create an empty migration file to write by hand.\n\n" +
      "Prefer schema generate when the change lives in supabase/schemas.",
  ),
  Command.withShortDescription("Create an empty migration"),
  Command.withExamples([
    {
      command: "supabase migrations new add_custom_data",
      description: "Create supabase/migrations/<timestamp>_add_custom_data.sql",
    },
  ]),
  Command.withHandler((flags) =>
    legacyMigrationsNew(flags).pipe(withLegacyCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(legacySchemaRuntimeLayer(["migrations", "new"])),
);
