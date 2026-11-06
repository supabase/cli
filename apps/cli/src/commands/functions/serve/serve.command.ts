import { Layer } from "effect";
import { httpClientLayer } from "../../../auth/http-debug.layer.ts";
import { Argument, Command, Flag } from "effect/cli";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { FUNCTIONS_SERVE_INSPECT_MODES } from "../../../shared/functions/serve.ts";
import { fileWatcherLayer } from "../../../shared/runtime/file-watcher.service.ts";
import { commandSettingsLayer } from "../../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { functionsServe } from "./serve.handler.ts";
import { stackApiLayer } from "../../../command-internal/stack-api.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliArgument, cliFlag, makeCommand, repeated } from "../../../shared/cli/cli-params.ts";

const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));
const functionsServeRuntimeLayer = Layer.mergeAll(
  fileWatcherLayer,
  httpClientLayer.pipe(Layer.provide(debugLoggerLayer)),
  cliSettings,
  debugLoggerLayer,
  telemetryStateLayer,
  commandRuntimeLayer(["functions", "serve"]),
  stackApiLayer,
);

const config = {
  noVerifyJwt: cliFlag("no-verify-jwt", Flag.Boolean, {
    description: "Disable JWT verification for the functions.",
    optional: true,
  }),
  envFile: cliFlag("env-file", Flag.String, {
    description:
      "Path to an env file that overrides `supabase/functions/.env` and per-function `.env` files.",
    optional: true,
  }),
  importMap: cliFlag("import-map", Flag.String, {
    description: "Path to an import map file.",
    optional: true,
  }),
  inspect: cliFlag("inspect", Flag.Boolean, {
    description: "Alias of `--inspect-mode brk`.",
    default: false,
  }),
  inspectMode: cliFlag(
    "inspect-mode",
    (name) => Flag.Literals(name, FUNCTIONS_SERVE_INSPECT_MODES),
    { description: "Activate the inspector in the given mode for debugging.", optional: true },
  ),
  inspectMain: cliFlag("inspect-main", Flag.Boolean, {
    description: "Allow inspecting the main worker; requires an inspect flag.",
    default: false,
  }),
  all: cliFlag("all", Flag.Boolean, {
    description: "Serve all functions.",
    default: true,
    hidden: true,
  }),
} as const;

const commandConfig = {
  ...config,
  functionNames: cliArgument("Function name", repeated(Argument.String), {
    description: "Legacy function names; all functions are served regardless.",
  }),
} as const;

export const functionsServeCommand = makeCommand("serve", commandConfig).pipe(
  Command.withDescription(
    "Run all Edge Functions in `supabase/functions` locally, so you can test them before deploying.",
  ),
  Command.withShortDescription("Serve Edge Functions locally"),
  Command.withExamples([
    {
      command: "supabase functions serve",
      description: "Serve all functions locally",
    },
    {
      command: "supabase functions serve --env-file .env.local",
      description: "Serve with a custom env file",
    },
    {
      command: "supabase functions serve --inspect-mode brk",
      description: "Serve with the inspector paused at the first line",
    },
  ]),
  withPermissions({
    operations: [],
    noApiEffectFlags: [
      "no-verify-jwt",
      "env-file",
      "import-map",
      "inspect",
      "inspect-mode",
      "inspect-main",
      "all",
    ],
  }),
  Command.withHandler((flags) =>
    functionsServe(flags).pipe(withCommandTelemetry({ flags, config }), withJsonErrorHandling),
  ),
  Command.provide(functionsServeRuntimeLayer),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(commandConfig),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);
