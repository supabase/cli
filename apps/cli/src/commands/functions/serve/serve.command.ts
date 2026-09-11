import { Layer } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import {
  FUNCTIONS_SERVE_INSPECT_MODES,
  serveFileWatcherLayer,
} from "../../../shared/functions/serve.ts";
import { commandSettingsLayer } from "../../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { functionsServe } from "./serve.handler.ts";

const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));
const functionsServeRuntimeLayer = Layer.mergeAll(
  serveFileWatcherLayer,
  cliSettings,
  debugLoggerLayer,
  telemetryStateLayer,
  commandRuntimeLayer(["functions", "serve"]),
);

const config = {
  noVerifyJwt: Flag.Boolean("no-verify-jwt").pipe(
    Flag.withDescription("Disable JWT verification for the Function."),
    Flag.optional,
  ),
  envFile: Flag.String("env-file").pipe(
    Flag.withDescription(
      "Path to an env file. Overrides supabase/functions/.env and per-Function .env files.",
    ),
    Flag.optional,
  ),
  importMap: Flag.String("import-map").pipe(
    Flag.withDescription("Path to import map file."),
    Flag.optional,
  ),
  inspect: Flag.Boolean("inspect").pipe(
    Flag.withDescription("Alias of --inspect-mode brk."),
    Flag.withDefault(false),
  ),
  inspectMode: Flag.Literals("inspect-mode", FUNCTIONS_SERVE_INSPECT_MODES).pipe(
    Flag.withDescription("Activate inspector capability for debugging."),
    Flag.optional,
  ),
  inspectMain: Flag.Boolean("inspect-main").pipe(
    Flag.withDescription("Allow inspecting the main worker."),
    Flag.withDefault(false),
  ),
  all: Flag.Boolean("all").pipe(
    Flag.withDescription("Serve all Functions."),
    Flag.withDefault(true),
    Flag.withHidden,
  ),
} as const;

const commandConfig = {
  ...config,
  functionNames: Argument.String("Function name").pipe(
    Argument.withDescription("Legacy Function names. All Functions are served."),
    Argument.variadic(),
  ),
} as const;

export const functionsServeCommand = Command.make("serve", commandConfig).pipe(
  Command.withDescription("Serve all Functions locally."),
  Command.withShortDescription("Serve all Functions locally"),
  Command.withHandler((flags) =>
    functionsServe(flags).pipe(withCommandTelemetry({ flags, config }), withJsonErrorHandling),
  ),
  Command.provide(functionsServeRuntimeLayer),
);
