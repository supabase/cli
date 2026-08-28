import { Layer } from "effect";

import { legacyHttpClientLayer } from "../../../auth/legacy-http-debug.layer.ts";
import { legacyCliSettingsLayer } from "../../../config/legacy-cli-settings.layer.ts";
import { legacyDbConfigLayer } from "../../../shared/legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "../../../shared/legacy-db-connection.layer.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { legacyDockerRunLayer } from "../../../shared/legacy-docker-run.layer.ts";
import { legacyEdgeRuntimeScriptLayer } from "../../../shared/legacy-edge-runtime-script.layer.ts";
import { legacyIdentityStitchLayer } from "../../../shared/legacy-identity-stitch.ts";
import { legacyPgDeltaSslProbeLayer } from "../../../shared/legacy-pgdelta-ssl-probe.layer.ts";
import { legacyPgDeltaNextEngineLayer } from "./legacy-pgdelta-engine.next.layer.ts";
import { legacyPgDeltaNextAdapterLayer } from "./legacy-pgdelta-next-adapter.layer.ts";
import { legacyPgDeltaNextShadowLayer } from "./legacy-pgdelta-next-shadow.layer.ts";
import { legacyDeclarativeSeamLayer } from "./legacy-pgdelta.seam.layer.ts";

/** The in-process pg-delta engine — the only implementation. */
export const legacyPgDeltaEngineLayer = legacyPgDeltaNextEngineLayer;

export const legacyPgDeltaCliSettingsRuntimeLayer = legacyCliSettingsLayer.pipe(
  Layer.provide(legacyDebugLoggerLayer),
);

export const legacyPgDeltaDbConfigRuntimeLayer = legacyDbConfigLayer.pipe(
  Layer.provide(legacyPgDeltaCliSettingsRuntimeLayer),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(legacyDebugLoggerLayer),
  Layer.provide(legacyIdentityStitchLayer),
);

const edgeRuntime = legacyEdgeRuntimeScriptLayer.pipe(
  Layer.provide(legacyDockerRunLayer),
  Layer.provide(legacyPgDeltaCliSettingsRuntimeLayer),
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
  edgeRuntime,
  legacyPgDeltaSslProbeLayer,
  httpClient,
  seam,
  engine,
  legacyPgDeltaCliSettingsRuntimeLayer,
);
