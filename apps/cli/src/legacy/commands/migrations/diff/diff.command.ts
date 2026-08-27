import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacySchemaRuntimeLayer } from "../../../schema/legacy-schema-runtime.layer.ts";
import { legacyMigrationsDiff } from "./diff.handler.ts";

const config = {
  against: Flag.string("against").pipe(
    Flag.withDescription(
      "Live database to compare. Defaults to local. Also accepts linked or a connection string.",
    ),
    Flag.withDefault("local"),
  ),
  file: Flag.string("file").pipe(
    Flag.withDescription("Write preview SQL to a file without applying it."),
    Flag.withAlias("f"),
    Flag.optional,
  ),
} as const;

export type LegacyMigrationsDiffFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyMigrationsDiffCommand = Command.make("diff", config).pipe(
  Command.withDescription(
    "Preview the SQL that would make migration replay match a live database.\n\n" +
      "Does not apply anything. Defaults to the local database.\n\n" +
      "To record a live edit, write --file then `migration repair --status applied` (repair upserts statements and does not run SQL).",
  ),
  Command.withShortDescription("Preview drift between migrations and a database"),
  Command.withExamples([
    { command: "supabase migrations diff", description: "Preview local drift" },
    { command: "supabase migrations diff --against linked", description: "Preview remote drift" },
  ]),
  Command.withHandler((flags) =>
    legacyMigrationsDiff(flags).pipe(
      withLegacyCommandInstrumentation({ flags, config, aliases: { f: "file" } }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacySchemaRuntimeLayer(["migrations", "diff"])),
);
