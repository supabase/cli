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
    "Show which migration files are applied, pending, or remote-only.\n\n" +
      "This is history alignment (file versions vs the database history table), not a schema diff.\n\n" +
      "Defaults to the local database. Pass --against linked to list the linked project.",
  ),
  Command.withShortDescription("List applied, pending, and remote-only migrations"),
  Command.withExamples([
    {
      command: "supabase migrations list",
      description: "Show applied vs pending on the local database",
    },
    {
      command: "supabase migrations list --against linked",
      description: "Show history alignment on the linked project",
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
