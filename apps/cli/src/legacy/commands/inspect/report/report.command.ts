import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInspectReport } from "./report.handler.ts";

const config = {
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Inspect the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(Flag.withDescription("Inspect the linked project.")),
  local: Flag.boolean("local").pipe(Flag.withDescription("Inspect the local database.")),
  outputDir: Flag.string("output-dir").pipe(
    Flag.withDescription("Path to save CSV files in."),
    Flag.withDefault("."),
  ),
} as const;

export type LegacyInspectReportFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInspectReportCommand = Command.make("report", config).pipe(
  Command.withDescription("Generate a CSV output for all inspect commands."),
  Command.withShortDescription("Generate CSV report for all inspect commands"),
  Command.withHandler((flags) => legacyInspectReport(flags)),
);
