import { Layer } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { commandSettingsLayer } from "../../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { functionsNew } from "./new.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliArgument, cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

const AUTH_MODE_VALUES = ["none", "apikey", "user"] as const;

const config = {
  functionName: cliArgument("Function name", Argument.String, {
    description: "Name of the function to create.",
    required: true,
  }),
  auth: cliFlag("auth", (name) => Flag.Literals(name, AUTH_MODE_VALUES), {
    description: "Auth mode to scaffold the function with.",
    default: "apikey" as const,
  }),
} as const;

export type FunctionsNewFlags = CliCommand.Command.Config.Infer<typeof config>;

const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));

const functionsNewRuntimeLayer = Layer.mergeAll(
  cliSettings,
  telemetryStateLayer,
  commandRuntimeLayer(["functions", "new"]),
  // `stdinLayer`: the first-function IDE prompts read piped stdin via
  // `promptYesNo`.
  stdinLayer,
);

export const functionsNewCommand = makeCommand("new", config).pipe(
  Command.withDescription(
    "Scaffold a starter Edge Function in `supabase/functions/<name>`, ready to edit and serve locally.",
  ),
  Command.withShortDescription("Create an Edge Function locally"),
  Command.withExamples([
    {
      command: "supabase functions new my-function",
      description: "Create a new function",
    },
    {
      command: "supabase functions new my-function --auth user",
      description: "Create a function with the user auth mode",
    },
  ]),
  withPermissions({ operations: [], noApiEffectFlags: ["auth"] }),
  Command.withHandler((flags) =>
    functionsNew(flags).pipe(withCommandTelemetry({ flags, config }), withJsonErrorHandling),
  ),
  Command.provide(functionsNewRuntimeLayer),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);
