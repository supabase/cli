import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacySchemaRuntimeLayer } from "../../../schema/legacy-schema-runtime.layer.ts";
import { legacyMigrationsDiff } from "./diff.handler.ts";

const config = {
  against: Flag.string("against").pipe(
    Flag.withDescription("Live database to compare: local, linked, or a connection string."),
    Flag.optional,
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
    "Preview the SQL required to move from migration replay to a live database.\n\n" +
      "This is the successor to db diff. It never mutates the database.",
  ),
  Command.withShortDescription("Diff migration replay against a live database"),
  Command.withExamples([
    { command: "supabase migrations diff --against local", description: "Preview local drift" },
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
