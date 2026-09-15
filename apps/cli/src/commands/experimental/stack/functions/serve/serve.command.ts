import { Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { debugLoggerLayer } from "../../../../../command-internal/debug-logger.layer.ts";
import { commandSettingsLayer } from "../../../../../config/command-settings.layer.ts";
import {
  functionsServeCommandConfig,
  functionsServeFlagConfig,
} from "../../../../../commands/functions/serve/serve.command.ts";
import { serveFileWatcherLayer } from "../../../../../shared/functions/serve.ts";
import { withJsonErrorHandling } from "../../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../../../../telemetry/command-telemetry.ts";
import { telemetryStateLayer } from "../../../../../telemetry/telemetry-state.layer.ts";
import { stackRuntimeLayer } from "../../stack.command.ts";
import { functionsServeStack } from "./serve.handler.ts";

const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));
const functionsServeStackRuntimeLayer = Layer.mergeAll(
  serveFileWatcherLayer,
  cliSettings,
  debugLoggerLayer,
  telemetryStateLayer,
  stackRuntimeLayer,
  commandRuntimeLayer(["functions", "serve"]),
);

export const functionsServeStackCommand = Command.make("serve", functionsServeCommandConfig).pipe(
  Command.withDescription("Serve all Functions locally."),
  Command.withShortDescription("Serve all Functions locally"),
  Command.withHandler((flags) =>
    functionsServeStack(flags).pipe(
      withCommandTelemetry({ flags, config: functionsServeFlagConfig }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(functionsServeStackRuntimeLayer),
);
