import { Layer } from "effect";

import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { legacyCliConfigLayer } from "../../../config/legacy-cli-config.layer.ts";
import { legacyDbConfigLayer } from "../../../shared/legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "../../../shared/legacy-db-connection.layer.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { legacyDockerRunLayer } from "../../../shared/legacy-docker-run.layer.ts";
import { legacyEdgeRuntimeScriptLayer } from "../../../shared/legacy-edge-runtime-script.layer.ts";
import { legacyIdentityStitchLayer } from "../../../shared/legacy-identity-stitch.ts";
import { legacyLinkedDbResolverRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { legacyPgDeltaSslProbeLayer } from "../../../shared/legacy-pgdelta-ssl-probe.layer.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";
import { stdinLayer } from "../../../../shared/runtime/stdin.layer.ts";
import { legacyDeclarativeSeamLayer } from "../shared/legacy-pgdelta.seam.layer.ts";
import { legacyPgDeltaEngineLayer } from "../shared/legacy-pgdelta-engine.layer.ts";
import { legacyPgDeltaNextAdapterLayer } from "../shared/legacy-pgdelta-next-adapter.layer.ts";
import { legacyPgDeltaNextShadowLayer } from "../shared/legacy-pgdelta-next-shadow.layer.ts";

/**
 * Runtime layer for `supabase db pull`. Same composition as `db diff`: the
 * db-config resolver, both pg-delta implementations, migra, the SSL probe, and
 * the Go shadow seam. The default pg-delta runs in-process; edge-runtime remains
 * for migra and the explicit legacy opt-out. `LegacyDbConnection` (remote connect + `schema_migrations`
 * reconciliation / history update), and `LegacyDockerRun` for the migra fallback.
 */
const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

const dbConfig = legacyDbConfigLayer.pipe(
  Layer.provide(cliConfig),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(legacyDebugLoggerLayer),
  Layer.provide(legacyIdentityStitchLayer),
);

const edgeRuntime = legacyEdgeRuntimeScriptLayer.pipe(
  Layer.provide(legacyDockerRunLayer),
  Layer.provide(cliConfig),
);

const seam = legacyDeclarativeSeamLayer.pipe(Layer.provide(cliConfig));
const nextShadow = legacyPgDeltaNextShadowLayer.pipe(Layer.provide(seam));
const pgDeltaEngine = legacyPgDeltaEngineLayer.pipe(
  Layer.provide(cliConfig),
  Layer.provide(legacyPgDeltaNextAdapterLayer),
  Layer.provide(nextShadow),
  Layer.provide(edgeRuntime),
  Layer.provide(legacyPgDeltaSslProbeLayer),
  Layer.provide(seam),
  Layer.provide(legacyDebugLoggerLayer),
);

export const legacyDbPullRuntimeLayer = Layer.mergeAll(
  dbConfig,
  legacyDbConnectionLayer,
  legacyDockerRunLayer,
  edgeRuntime,
  legacyPgDeltaSslProbeLayer,
  seam,
  pgDeltaEngine,
  cliConfig,
  legacyIdentityStitchLayer,
  legacyTelemetryStateLayer,
  legacyLinkedDbResolverRuntimeLayer(["db", "pull"]).pipe(Layer.provide(legacyIdentityStitchLayer)),
  commandRuntimeLayer(["db", "pull"]),
  stdinLayer,
);
