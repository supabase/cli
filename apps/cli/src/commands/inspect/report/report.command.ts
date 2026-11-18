import { Layer } from "effect";
import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { dbConfig } from "../../../command-internal/db-config.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { inspectReport } from "./report.handler.ts";
import { inspectBaseLayer } from "../inspect.layers.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  ...targetFlags({ subject: "database", dbUrl: true }),
  outputDir: cliFlag("output-dir", Flag.String, {
    description: "Directory to create the dated report folder in.",
    default: ".",
  }),
} as const;

export type InspectReportFlags = CliCommand.Command.Config.Infer<typeof config>;

export const inspectReportCommand = makeCommand("report", config).pipe(
  Command.withDescription(
    "Run every inspect query and write each result to its own CSV file in a dated folder, then check the results against a set of rules and print a summary. It reports on the local database by default; pass --remote for the linked project, or --remote=<ref|branch|url> for another database.",
  ),
  Command.withShortDescription("Export all inspect results as CSV files"),
  Command.withExamples([
    {
      command: "supabase inspect report",
      description: "Write CSV reports for the local database",
    },
    {
      command: "supabase inspect report --remote --output-dir ./reports",
      description: "Write CSV reports for the linked project to ./reports",
    },
  ]),
  withPermissions(
    compose({ operations: [], noApiEffectFlags: ["output-dir"] }, dbConfig, branchResolution),
  ),
  Command.withHandler((flags) =>
    inspectReport(flags).pipe(
      withCommandTelemetry({
        flags: {
          "output-dir": flags.outputDir,
        },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(Layer.merge(inspectBaseLayer, commandRuntimeLayer(["inspect", "report"]))),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({
    group: "selectable",
    consent: "none",
    consentExemptReason: "reads the target and writes only local report files",
  }),
);
