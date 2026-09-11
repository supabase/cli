import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { inspectReport } from "./report.handler.ts";
import { inspectReportRuntimeLayer } from "./report.layers.ts";

const config = {
  dbUrl: Flag.String("db-url").pipe(
    Flag.withDescription(
      "Inspect the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.Boolean("linked").pipe(
    Flag.withDescription("Inspect the linked project."),
    Flag.withDefault(false),
  ),
  local: Flag.Boolean("local").pipe(
    Flag.withDescription("Inspect the local database."),
    Flag.withDefault(false),
  ),
  // TS-only override of the linked project ref — see push.command.ts (db push).
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  outputDir: Flag.String("output-dir").pipe(
    Flag.withDescription("Path to save CSV files in."),
    Flag.withDefault("."),
  ),
} as const;

export type InspectReportFlags = CliCommand.Command.Config.Infer<typeof config>;

export const inspectReportCommand = Command.make("report", config).pipe(
  Command.withDescription("Generate a CSV output for all inspect commands."),
  Command.withShortDescription("Generate a CSV output for all inspect commands"),
  Command.withHandler((flags) =>
    inspectReport(flags).pipe(
      withCommandTelemetry({
        flags: {
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "project-ref": flags.projectRef,
          "output-dir": flags.outputDir,
        },
        // `--project-ref` has no telemetry-safety baseline, so it stays redacted.
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(inspectReportRuntimeLayer),
);
