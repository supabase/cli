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
 * fallback. Unlike `db diff`, no `LegacyDeclarativeSeam` — `db pull` has no Go-delegate branch
 * left that needs it (native shadow provisioning replaced the Go seam here entirely; `db diff`
 * still delegates `--use-pgadmin`/`--use-pg-schema` to Go, so it still wires the seam layer).
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
