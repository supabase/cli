import { Layer } from "effect";
import { cliConfigLayer } from "../../next/config/cli-config.layer.ts";
import { projectContextLayer } from "../../next/config/project-context.layer.ts";
import { runtimeInfoLayer } from "../runtime/runtime-info.layer.ts";
import { ttyLayer } from "../runtime/tty.layer.ts";

/**
 * Resolves `CliConfig | RuntimeInfo | Tty` — the services `telemetryRuntimeLayer`
 * (and, transitively, `analyticsLayer`/`legacyAnalyticsLayer`) need beyond the
 * `FileSystem`/`Path` platform layer — for callers that build and run an
 * `Analytics`-capturing effect OUTSIDE `runCli`'s own composed layer tree
 * (`shared/cli/run.ts` already wires the equivalent of this inline for every
 * command run via its own `cliConfigLayerFor`/`projectContextLayerFor`
 * helpers). The one caller today is `legacy/cli/legacy-complete.ts`'s
 * `__complete`/`__completeNoDesc` telemetry capture, which fires before
 * `runCli` ever bootstraps.
 *
 * Still requires the platform layer (`FileSystem`/`Path`, e.g.
 * `@effect/platform-bun`'s `BunServices.layer`) to be provided separately by
 * the caller, matching `run.ts`'s own top-level `Effect.provide(BunServices.layer)`.
 */
export const standaloneAnalyticsConfigLayer = Layer.mergeAll(
  cliConfigLayer.pipe(Layer.provide(projectContextLayer), Layer.provide(runtimeInfoLayer)),
  runtimeInfoLayer,
  ttyLayer,
);
