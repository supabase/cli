import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyInspectReport } from "./report.handler.ts";
import { legacyInspectReportRuntimeLayer } from "./report.layers.ts";

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
  Command.withShortDescription("Generate a CSV output for all inspect commands"),
  Command.withHandler((flags) =>
    legacyInspectReport(flags).pipe(
      withLegacyCommandInstrumentation({
        flags: {
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "output-dir": flags.outputDir,
        },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyInspectReportRuntimeLayer),
);
