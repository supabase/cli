import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandInstrumentation } from "../../../../shared/telemetry/command-instrumentation.ts";
import { schemaRuntimeLayer } from "../../../../shared/schema/schema-runtime.layer.ts";
import { migrationsDiff } from "./diff.handler.ts";

const flags = {
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

export type MigrationsDiffFlags = CliCommand.Command.Config.Infer<typeof flags>;

export const migrationsDiffCommand = Command.make("diff", flags).pipe(
  Command.withDescription(
    "Preview the SQL required to move from migration replay to a live database.\n\n" +
      "This is the successor to db diff. It never mutates the database.",
  ),
  Command.withShortDescription("Diff migration replay against a live database"),
  Command.withExamples([
    { command: "supabase migrations diff --against local", description: "Preview local drift" },
    { command: "supabase migrations diff --against linked", description: "Preview remote drift" },
  ]),
  Command.withHandler((commandFlags) =>
    migrationsDiff(commandFlags).pipe(
      withCommandInstrumentation({ flags: commandFlags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(schemaRuntimeLayer(["migrations", "diff"])),
);
