import { Layer } from "effect";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { legacyCliConfigLayer } from "../../config/legacy-cli-config.layer.ts";
import { legacyDebugLoggerLayer } from "../../shared/legacy-debug-logger.layer.ts";
import { legacyTelemetryStateLayer } from "../../telemetry/legacy-telemetry-state.layer.ts";

/**
 * Runtime layer for `supabase remotes {list,add,remove}` — pure local config
 * reads/writes, no Management API, no Docker. Deliberately lighter than
 * `legacyManagementApiRuntimeLayer`: no credentials/platform-API stack, since
 * these commands never need a token.
 */
export function legacyRemotesRuntimeLayer(subcommand: ReadonlyArray<string>) {
  const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
  return Layer.mergeAll(cliConfig, legacyTelemetryStateLayer, commandRuntimeLayer([...subcommand]));
}
