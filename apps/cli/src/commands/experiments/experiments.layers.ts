import { Layer } from "effect";
import { debugLoggerLayer } from "../../command-internal/debug-logger.layer.ts";
import { commandSettingsLayer } from "../../config/command-settings.layer.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { telemetryStateLayer } from "../../telemetry/telemetry-state.layer.ts";

const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));

/**
 * Local-disk only: these commands edit `supabase/config.{toml,json}` and call no Management
 * API, so no platform stack is built. `CommandSettings` supplies the same resolved workdir
 * every other command acts on.
 */
export const experimentsRuntimeLayer = (commandPath: ReadonlyArray<string>) =>
  Layer.mergeAll(cliSettings, telemetryStateLayer, commandRuntimeLayer(commandPath));
