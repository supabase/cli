import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacySchemaRuntimeLayer } from "../../../schema/legacy-schema-runtime.layer.ts";
import { legacyMigrationsPull } from "./pull.handler.ts";

const config = {
  from: Flag.string("from").pipe(
    Flag.withDescription("Remote database. Defaults to linked. Also accepts a connection string."),
    Flag.withDefault("linked"),
  ),
} as const;

export type LegacyMigrationsPullFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyMigrationsPullCommand = Command.make("pull", config).pipe(
  Command.withDescription(
    "Fetch remote migration history files from schema_migrations (version, name, statements).\n\n" +
      "Defaults to the linked project. Writes supabase/migrations/<version>_<name>.sql. Does not execute SQL.\n\n" +
      "Same version and SQL is skipped. A SQL mismatch leaves the local file and writes the remote copy under .supabase/remote-migrations/.",
  ),
  Command.withShortDescription("Fetch remote migration history files"),
  Command.withExamples([
    { command: "supabase migrations pull", description: "Fetch linked-project history files" },
    {
      command: "supabase migrations pull --from <db-url>",
      description: "Fetch history files from a connection string",
    },
  ]),
  Command.withHandler((flags) =>
    legacyMigrationsPull(flags).pipe(
      withLegacyCommandInstrumentation({ flags, config }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacySchemaRuntimeLayer(["migrations", "pull"])),
);
