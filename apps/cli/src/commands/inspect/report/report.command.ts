import { Layer } from "effect";
import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withDbTarget } from "../../../command-internal/command-permissions/model.ts";
import { dbConfig } from "../../../command-internal/db-config.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { inspectReport } from "./report.handler.ts";
import { inspectBaseLayer } from "../inspect.layers.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  ...targetFlags({ group: "selectable", subject: "database", dbUrl: true }),
  outputDir: Flag.String("output-dir").pipe(
    Flag.withDescription("Path to save CSV files in."),
    Flag.withDefault("."),
  ),
} as const;

export type InspectReportFlags = CliCommand.Command.Config.Infer<typeof config>;

export const inspectReportCommand = Command.make("report", config).pipe(
  Command.withDescription("Generate a CSV output for all inspect commands."),
  Command.withShortDescription("Generate a CSV output for all inspect commands"),
  withPermissions(
    withDbTarget(compose({ operations: [], noApiEffectFlags: ["output-dir"] }, dbConfig), {
      default: "local",
    }),
  ),
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
  Command.provide(Layer.merge(inspectBaseLayer, commandRuntimeLayer(["inspect", "report"]))),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "selectable", consent: "none" }),
);
