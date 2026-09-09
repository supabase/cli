import { Layer } from "effect";

import { httpClientLayer } from "../auth/http-debug.layer.ts";
import { commandSettingsLayer } from "../config/command-settings.layer.ts";
import { dbConfigLayer } from "./db-config.layer.ts";
import { dbConnectionLayer } from "./db-connection.layer.ts";
import { debugLoggerLayer } from "./debug-logger.layer.ts";
import { dockerRunLayer } from "./docker-run.layer.ts";
import { edgeRuntimeScriptLayer } from "./edge-runtime-script.layer.ts";
import { identityStitchLayer } from "./identity-stitch.ts";
import { pgDeltaSslProbeLayer } from "./pgdelta-ssl-probe.layer.ts";
import { pgDeltaNextEngineLayer } from "../commands/db/shared/pgdelta-engine.next.layer.ts";
import { pgDeltaNextAdapterLayer } from "../commands/db/shared/pgdelta-next-adapter.layer.ts";
import { pgDeltaNextShadowLayer } from "../commands/db/shared/pgdelta-next-shadow.layer.ts";
import { declarativeSeamLayer } from "../commands/db/shared/pgdelta.seam.layer.ts";

/** The in-process pg-delta engine — the only implementation. */
const pgDeltaEngineLayer = pgDeltaNextEngineLayer;

const pgDeltaCommandSettingsRuntimeLayer = commandSettingsLayer.pipe(
  Layer.provide(debugLoggerLayer),
);

export const pgDeltaDbConfigRuntimeLayer = dbConfigLayer.pipe(
  Layer.provide(pgDeltaCommandSettingsRuntimeLayer),
  Layer.provide(dbConnectionLayer),
  Layer.provide(debugLoggerLayer),
  Layer.provide(identityStitchLayer),
);

/**
 * The migra runtime: the edge-runtime script runner and the TLS probe migra's
 * containerized diff needs. Only `db diff` / migration-style `db pull` can select
 * migra; the declarative commands run the in-process pg-delta engine alone, so
 * this is composed by those two command layers rather than by
 * {@link pgDeltaCommandRuntimeLayer}.
 */
export const migraRuntimeLayer = Layer.mergeAll(
  edgeRuntimeScriptLayer.pipe(
    Layer.provide(dockerRunLayer),
    Layer.provide(pgDeltaCommandSettingsRuntimeLayer),
  ),
  pgDeltaSslProbeLayer,
);
const httpClient = httpClientLayer.pipe(Layer.provide(debugLoggerLayer));
const seam = declarativeSeamLayer.pipe(
  Layer.provide(pgDeltaCommandSettingsRuntimeLayer),
  Layer.provide(dbConnectionLayer),
  Layer.provide(dockerRunLayer),
  Layer.provide(httpClient),
);
const nextShadow = pgDeltaNextShadowLayer.pipe(
  Layer.provide(dockerRunLayer),
  Layer.provide(dbConnectionLayer),
  Layer.provide(httpClient),
);
const engine = pgDeltaEngineLayer.pipe(
  Layer.provide(pgDeltaCommandSettingsRuntimeLayer),
  Layer.provide(pgDeltaNextAdapterLayer),
  Layer.provide(nextShadow),
  Layer.provide(dockerRunLayer),
  Layer.provide(dbConnectionLayer),
  Layer.provide(httpClient),
  Layer.provide(debugLoggerLayer),
);

export const pgDeltaCommandRuntimeLayer = Layer.mergeAll(
  dbConnectionLayer,
  dockerRunLayer,
  httpClient,
  seam,
  engine,
  pgDeltaCommandSettingsRuntimeLayer,
);
