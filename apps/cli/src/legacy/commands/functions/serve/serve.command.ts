import { Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import {
  FUNCTIONS_SERVE_INSPECT_MODES,
  serveFileWatcherLayer,
} from "../../../../shared/functions/serve.ts";
import { legacyCliConfigLayer } from "../../../config/legacy-cli-config.layer.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";
import { legacyFunctionsServe } from "./serve.handler.ts";

const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
const legacyFunctionsServeRuntimeLayer = Layer.mergeAll(
  serveFileWatcherLayer,
  cliConfig,
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
    Flag.withDescription("Path to an env file to be populated to the Function environment."),
    Flag.optional,
  ),
  importMap: Flag.string("import-map").pipe(
    Flag.withDescription("Path to import map file."),
    Flag.optional,
  ),
  inspect: Flag.boolean("inspect").pipe(Flag.withDescription("Alias of --inspect-mode brk.")),
  inspectMode: Flag.choice("inspect-mode", FUNCTIONS_SERVE_INSPECT_MODES).pipe(
    Flag.withDescription("Activate inspector capability for debugging."),
    Flag.optional,
  ),
  inspectMain: Flag.boolean("inspect-main").pipe(
    Flag.withDescription("Allow inspecting the main worker."),
  ),
  all: Flag.boolean("all").pipe(
    Flag.withDescription("Serve all Functions."),
    Flag.withDefault(true),
    Flag.withHidden,
  ),
} as const;

export const legacyFunctionsServeCommand = Command.make("serve", config).pipe(
  Command.withDescription("Serve all Functions locally."),
  Command.withShortDescription("Serve all Functions locally"),
  Command.withHandler((flags) =>
    legacyFunctionsServe(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyFunctionsServeRuntimeLayer),
);
