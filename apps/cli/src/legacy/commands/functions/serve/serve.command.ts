import { Layer } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { legacyCliSettingsLayer } from "../../../config/legacy-cli-settings.layer.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";
import { legacyFunctionsServe } from "./serve.handler.ts";

const cliSettings = legacyCliSettingsLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
const legacyFunctionsServeRuntimeLayer = Layer.mergeAll(
  cliSettings,
  legacyDebugLoggerLayer,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["functions", "serve"]),
);

const config = {
  noVerifyJwt: Flag.boolean("no-verify-jwt").pipe(
    Flag.withDescription("Disable JWT verification for the Function."),
    Flag.optional,
  ),
  envFile: Flag.string("env-file").pipe(
    Flag.withDescription(
      "Path to an env file. Overrides supabase/functions/.env and per-Function .env files.",
    ),
    Flag.optional,
  ),
  importMap: Flag.string("import-map").pipe(
    Flag.withDescription("Path to import map file."),
    Flag.optional,
  ),
  inspect: Flag.boolean("inspect").pipe(
    Flag.withDescription("Alias of --inspect-mode brk."),
    Flag.withDefault(false),
  ),
  inspectMode: Flag.choice("inspect-mode", ["run", "brk", "wait"] as const).pipe(
    Flag.withDescription("Activate inspector capability for debugging."),
    Flag.optional,
  ),
  inspectMain: Flag.boolean("inspect-main").pipe(
    Flag.withDescription("Allow inspecting the main worker."),
    Flag.withDefault(false),
  ),
  all: Flag.boolean("all").pipe(
    Flag.withDescription("Serve all Functions."),
    Flag.withDefault(true),
    Flag.withHidden,
  ),
} as const;

const commandConfig = {
  ...config,
  legacyFunctionNames: Argument.string("Function name").pipe(
    Argument.withDescription("Legacy Function names. All Functions are served."),
    Argument.variadic(),
  ),
} as const;

export const legacyFunctionsServeCommand = Command.make("serve", commandConfig).pipe(
  Command.withDescription("Serve all Functions locally."),
  Command.withShortDescription("Serve all Functions locally"),
  Command.withHandler((flags) =>
    legacyFunctionsServe(flags).pipe(
      withLegacyCommandInstrumentation({ flags, config }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyFunctionsServeRuntimeLayer),
);
