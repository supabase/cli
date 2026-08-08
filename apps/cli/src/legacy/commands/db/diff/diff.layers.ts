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
import { legacyDeclarativeSeamLayer } from "../shared/legacy-pgdelta.seam.layer.ts";
import { legacyPgDeltaEngineLayer } from "../shared/legacy-pgdelta-engine.layer.ts";
import { legacyPgDeltaNextAdapterLayer } from "../shared/legacy-pgdelta-next-adapter.layer.ts";
import { legacyPgDeltaNextShadowLayer } from "../shared/legacy-pgdelta-next-shadow.layer.ts";

/**
 * Runtime layer for `supabase db diff`.
 *
 * Mirrors `db schema declarative generate` (`generate.layers.ts`): the db-config
 * resolver plus both pg-delta implementations, migra, the SSL probe, and the Go
 * shadow-database seam (`provisionShadow`). The default pg-delta runs in-process;
 * the edge-runtime runner is retained only for migra and the explicit legacy opt-out.
 * `LegacyDockerRun`
 * is exposed in the merge (not just provided to the edge-runtime layer) because the
 * migra OOM bash fallback runs the `supabase/migra` container directly.
 * Per the "provide doesn't share to siblings" rule, `LegacyCliConfig` is provided
 * to every layer that needs it.
 */
const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

const dbConfig = legacyDbConfigLayer.pipe(
  Layer.provide(cliConfig),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(legacyDebugLoggerLayer),
  // The linked db-config resolver snapshots the single `LegacyIdentityStitch`
  // (Go's one `sync.Once`); the command runtime must provide it or the bundled
  // binary panics with a missing-service error (legacy CLAUDE.md rule 5).
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

export const legacyDbDiffRuntimeLayer = Layer.mergeAll(
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
  // Go's PersistentPostRun writes the linked-project cache for `--linked`; this
  // bundle supplies `LegacyLinkedProjectCache` (+ the lazy Management-API runtime
  // it needs), mirroring `db schema declarative generate`.
  legacyLinkedDbResolverRuntimeLayer(["db", "diff"]).pipe(Layer.provide(legacyIdentityStitchLayer)),
  commandRuntimeLayer(["db", "diff"]),
);
