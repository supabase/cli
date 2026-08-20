import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacySchemaRuntimeLayer } from "../../../schema/legacy-schema-runtime.layer.ts";
import { legacyMigrationsList } from "./list.handler.ts";

const config = {
  against: Flag.string("against").pipe(
    Flag.withDescription(
      "Database to compare. Defaults to local. Also accepts linked or a connection string.",
    ),
    Flag.withDefault("local"),
  ),
} as const;

export type LegacyMigrationsListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyMigrationsListCommand = Command.make("list", config).pipe(
  Command.withDescription(
    "Show which migration files are present locally vs on a database.\n\n" +
      "Defaults to the local database. Pass --against linked to compare the linked project.",
  ),
  Command.withShortDescription("List local and remote migrations"),
  Command.withExamples([
    { command: "supabase migrations list", description: "Compare files to the local database" },
    {
      command: "supabase migrations list --against linked",
      description: "Compare files to the linked project",
    },
  ]),
  Command.withHandler((flags) =>
    legacyMigrationsList(flags).pipe(
      withLegacyCommandInstrumentation({ flags, config }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacySchemaRuntimeLayer(["migrations", "list"])),
);
