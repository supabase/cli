import type * as CliCommand from "effect/cli/Command";
import { Layer } from "effect";
import { Command, Flag } from "effect/cli";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { commandSettingsLayer } from "../../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { GLOBAL_OUTPUT_FORMATS } from "../../../command-internal/global-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { configConvert } from "./convert.handler.ts";

const config = {
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Print the converted config.jsonc to stdout without writing any file."),
    Flag.withDefault(false),
  ),
} as const;

export type ConfigConvertFlags = CliCommand.Command.Config.Infer<typeof config>;

const configConvertRuntimeLayer = Layer.mergeAll(
  commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer)),
  telemetryStateLayer,
  commandRuntimeLayer(["config", "convert"]),
);

const configConvertHandler = (flags: ConfigConvertFlags) =>
  configConvert(flags).pipe(
    // The handler rejects `-o/--output` itself with a pointer to `--output-format`.
    withCommandTelemetry({ flags, outputFormats: GLOBAL_OUTPUT_FORMATS }),
    withJsonErrorHandling,
  );

export const configConvertCommand = Command.make("convert", config).pipe(
  Command.withDescription(
    "Converts supabase/config.toml to supabase/config.jsonc, carrying comments over, and moves the TOML file to a backup in supabase/.temp. Everyone on the project needs Supabase CLI 3.1.0 or later.",
  ),
  Command.withShortDescription("Convert config.toml to config.jsonc"),
  Command.withExamples([
    {
      command: "supabase config convert --dry-run",
      description: "Preview the converted config.jsonc without writing it",
    },
    {
      command: "supabase config convert",
      description: "Convert supabase/config.toml to supabase/config.jsonc",
    },
  ]),
  withPermissions({ operations: [], noApiEffectFlags: ["dry-run"] }),
  Command.withHandler(configConvertHandler),
  Command.provide(configConvertRuntimeLayer),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);
