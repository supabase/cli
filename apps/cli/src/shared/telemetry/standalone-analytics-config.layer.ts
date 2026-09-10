import { Layer } from "effect";
import { cliSettingsLayer } from "../config/cli-settings.layer.ts";
import { cliProjectContextLayer } from "../config/cli-project-context.layer.ts";
import { runtimeInfoLayer } from "../runtime/runtime-info.layer.ts";
import { ttyLayer } from "../runtime/tty.layer.ts";

/**
 * Resolves `CliSettings | RuntimeInfo | Tty` for callers that build and run an
 * `Analytics`-capturing effect outside `runCli`'s own composed layer tree — today, only
 * `cli/complete.ts`'s telemetry capture, which fires before `runCli` bootstraps.
 *
 * Still requires the platform layer (`FileSystem`/`Path`) to be provided separately by the
 * caller, matching `run.ts`'s own top-level `Effect.provide(BunServices.layer)`.
 */
export const standaloneAnalyticsConfigLayer = Layer.mergeAll(
  cliSettingsLayer.pipe(Layer.provide(cliProjectContextLayer), Layer.provide(runtimeInfoLayer)),
  runtimeInfoLayer,
  ttyLayer,
);
