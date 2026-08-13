import { Layer } from "effect";

import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { legacyHttpClientLayer } from "../../../auth/legacy-http-debug.layer.ts";
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

/**
 * Runtime layer for `supabase db pull`. The db-config resolver, the native pg-delta / migra
 * stack (edge-runtime, SSL probe, `HttpClient` for the native shadow's health-check wait —
 * shadow provisioning itself is native, see `commands/db/shared/legacy-shadow-source.ts` /
 * `shared/db-bootstrap/shadow-database.ts`), `LegacyDbConnection` (remote connect +
 * `schema_migrations` reconciliation / history update), and `LegacyDockerRun` for the migra
 * fallback. No `LegacyDeclarativeSeam` — neither `db pull` nor `db diff` has a Go-delegate
 * branch that needs it any more (native shadow provisioning replaced it entirely);
 * `--use-pgadmin`/`--use-pg-schema` delegate through `LegacyGoProxy` instead, not this seam.
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

const httpClient = legacyHttpClientLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

export const legacyDbPullRuntimeLayer = Layer.mergeAll(
  dbConfig,
  legacyDbConnectionLayer,
  legacyDockerRunLayer,
  edgeRuntime,
  legacyPgDeltaSslProbeLayer,
  httpClient,
  cliConfig,
  legacyIdentityStitchLayer,
  legacyTelemetryStateLayer,
  legacyLinkedDbResolverRuntimeLayer(["db", "pull"]).pipe(Layer.provide(legacyIdentityStitchLayer)),
  commandRuntimeLayer(["db", "pull"]),
  stdinLayer,
);
