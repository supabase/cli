import type * as CliCommand from "effect/cli/Command";
import { Layer } from "effect";
import { Command } from "effect/cli";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { GLOBAL_OUTPUT_FORMATS } from "../../../command-internal/global-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { commandSettingsLayer } from "../../../config/command-settings.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { configValidate } from "./validate.handler.ts";

const config = {} as const;

export type ConfigValidateFlags = CliCommand.Command.Config.Infer<typeof config>;

const configValidateRuntimeLayer = Layer.mergeAll(
  commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer)),
  telemetryStateLayer,
  commandRuntimeLayer(["config", "validate"]),
);

const configValidateHandler = (flags: ConfigValidateFlags) =>
  configValidate().pipe(
    // The handler rejects `-o/--output` itself with a pointer to `--output-format`.
    withCommandTelemetry({ flags, outputFormats: GLOBAL_OUTPUT_FORMATS }),
    withJsonErrorHandling,
  );

export const configValidateCommand = Command.make("validate", config).pipe(
  Command.withDescription(
    "Checks the project config file for syntax errors, unknown and removed keys, invalid values and failed validations, and reports every problem with its line. Never modifies files or contacts the Supabase API. Exits 1 when any error is found.",
  ),
  Command.withShortDescription("Validate the project config file"),
  Command.withExamples([
    {
      command: "supabase config validate",
      description: "Validate supabase/config.toml, config.json or config.jsonc",
    },
    {
      command: "supabase config validate --workdir path/to/project",
      description: "Validate the config of another project directory",
    },
    {
      command: "supabase config validate --output-format json",
      description: "Print the report as JSON for scripts and agents",
    },
  ]),
  withPermissions({ operations: [] }),
  Command.withHandler(configValidateHandler),
  Command.provide(configValidateRuntimeLayer),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);
