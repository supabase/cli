import { Layer } from "effect";

import { legacyHttpClientLayer } from "../../../auth/legacy-http-debug.layer.ts";
import { legacyCliSettingsLayer } from "../../../config/legacy-cli-settings.layer.ts";
import { legacyDbConfigLayer } from "../../../command-internal/legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "../../../command-internal/legacy-db-connection.layer.ts";
import { legacyDebugLoggerLayer } from "../../../command-internal/legacy-debug-logger.layer.ts";
import { legacyDockerRunLayer } from "../../../command-internal/legacy-docker-run.layer.ts";
import { legacyEdgeRuntimeScriptLayer } from "../../../command-internal/legacy-edge-runtime-script.layer.ts";
import { legacyIdentityStitchLayer } from "../../../command-internal/legacy-identity-stitch.ts";
import { legacyPgDeltaSslProbeLayer } from "../../../command-internal/legacy-pgdelta-ssl-probe.layer.ts";
import { legacyPgDeltaNextEngineLayer } from "./legacy-pgdelta-engine.next.layer.ts";
import { legacyPgDeltaNextAdapterLayer } from "./legacy-pgdelta-next-adapter.layer.ts";
import { legacyPgDeltaNextShadowLayer } from "./legacy-pgdelta-next-shadow.layer.ts";
import { legacyDeclarativeSeamLayer } from "./legacy-pgdelta.seam.layer.ts";

/** The in-process pg-delta engine — the only implementation. */
const legacyPgDeltaEngineLayer = legacyPgDeltaNextEngineLayer;

const legacyPgDeltaCliSettingsRuntimeLayer = legacyCliSettingsLayer.pipe(
  Layer.provide(legacyDebugLoggerLayer),
);

export const legacyPgDeltaDbConfigRuntimeLayer = legacyDbConfigLayer.pipe(
  Layer.provide(legacyPgDeltaCliSettingsRuntimeLayer),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(legacyDebugLoggerLayer),
  Layer.provide(legacyIdentityStitchLayer),
);

/**
 * The migra runtime: the edge-runtime script runner and the TLS probe migra's
 * containerized diff needs. Only `db diff` / migration-style `db pull` can select
 * migra; the declarative commands run the in-process pg-delta engine alone, so
 * this is composed by those two command layers rather than by
 * {@link legacyPgDeltaCommandRuntimeLayer}.
 */
export const legacyMigraRuntimeLayer = Layer.mergeAll(
  legacyEdgeRuntimeScriptLayer.pipe(
    Layer.provide(legacyDockerRunLayer),
    Layer.provide(legacyPgDeltaCliSettingsRuntimeLayer),
  ),
  legacyPgDeltaSslProbeLayer,
);
const httpClient = legacyHttpClientLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
const seam = legacyDeclarativeSeamLayer.pipe(
  Layer.provide(legacyPgDeltaCliSettingsRuntimeLayer),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(legacyDockerRunLayer),
  Layer.provide(httpClient),
);
const nextShadow = legacyPgDeltaNextShadowLayer.pipe(
  Layer.provide(legacyDockerRunLayer),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(httpClient),
);
const engine = legacyPgDeltaEngineLayer.pipe(
  Layer.provide(legacyPgDeltaCliSettingsRuntimeLayer),
  Layer.provide(legacyPgDeltaNextAdapterLayer),
  Layer.provide(nextShadow),
  Layer.provide(legacyDockerRunLayer),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(httpClient),
  Layer.provide(legacyDebugLoggerLayer),
);

export const legacyPgDeltaCommandRuntimeLayer = Layer.mergeAll(
  legacyDbConnectionLayer,
  legacyDockerRunLayer,
  httpClient,
  seam,
  engine,
  legacyPgDeltaCliSettingsRuntimeLayer,
);
