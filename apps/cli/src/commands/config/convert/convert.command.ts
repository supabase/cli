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
import { CONVERT_REASONS } from "../../../telemetry/command-telemetry-attributes.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { configConvert } from "./convert.handler.ts";

const CONVERT_TARGETS = ["json", "toml"] as const;

const config = {
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Print the converted config to stdout without writing any file."),
    Flag.withDefault(false),
  ),
  to: Flag.Literals("to", CONVERT_TARGETS).pipe(
    Flag.withDescription(
      "Format to convert supabase/config to: json (writes config.jsonc) or toml.",
    ),
    Flag.withDefault("json"),
  ),
  reason: Flag.Literals("reason", CONVERT_REASONS).pipe(
    Flag.withDescription(
      "Why you're switching back to TOML. Only recorded as anonymous usage telemetry.",
    ),
    Flag.optional,
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
    withCommandTelemetry({ flags, config, outputFormats: GLOBAL_OUTPUT_FORMATS }),
    withJsonErrorHandling,
  );

export const configConvertCommand = Command.make("convert", config).pipe(
  Command.withDescription(
    "Converts supabase/config.toml to supabase/config.jsonc, carrying comments over, and moves the TOML file to supabase/config.toml.bak. Everyone on the project needs Supabase CLI 3.1.0 or later. With `--to toml`, converts supabase/config.jsonc (or config.json) back to supabase/config.toml and moves the JSON file to a `.bak` backup.",
  ),
  Command.withShortDescription("Convert config.toml to config.jsonc, or back with --to toml"),
  Command.withExamples([
    {
      command: "supabase config convert --dry-run",
      description: "Preview the converted config.jsonc without writing it",
    },
    {
      command: "supabase config convert",
      description: "Convert supabase/config.toml to supabase/config.jsonc",
    },
    {
      command: "supabase config convert --to toml",
      description: "Convert supabase/config.jsonc back to supabase/config.toml",
    },
  ]),
  withPermissions({ operations: [], noApiEffectFlags: ["dry-run", "to", "reason"] }),
  Command.withHandler(configConvertHandler),
  Command.provide(configConvertRuntimeLayer),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);
