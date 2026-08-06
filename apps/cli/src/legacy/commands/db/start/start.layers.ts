import { Layer } from "effect";

import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { legacyCliConfigLayer } from "../../../config/legacy-cli-config.layer.ts";
import { legacyHttpClientLayer } from "../../../auth/legacy-http-debug.layer.ts";
import { legacyDbConnectionLayer } from "../../../shared/legacy-db-connection.layer.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { legacyDockerRunLayer } from "../../../shared/legacy-docker-run.layer.ts";
import { legacyEdgeRuntimeScriptLayer } from "../../../shared/legacy-edge-runtime-script.layer.ts";
import { legacyPgDeltaSslProbeLayer } from "../../../shared/legacy-pgdelta-ssl-probe.layer.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";

/**
 * Runtime layer for `supabase db start`. `LegacyCliConfig`/`ChildProcessSpawner`/
 * `FileSystem`/`Path` are ambient from the root runtime (`shared/cli/run.ts`), matching
 * `supabase start`'s own layer composition (`start.command.ts`).
 *
 * No `LegacyDbBootstrapSeam` composition — `db start` no longer calls into the `db
 * __db-bootstrap` Go seam at all after CLI-1954: `legacyIsLocalDbRunning` (the
 * already-running check) and `legacyStartDatabase` (the container bring-up itself) are
 * both native TS, hoisted to `legacy/shared/db-bootstrap/`. `db reset --local` still
 * composes `legacyDbBootstrapSeamLayer` for its own container-recreate + storage-health
 * primitives (`reset.layers.ts`).
 *
 * `legacyDockerRunLayer`/`legacyDbConnectionLayer`/`legacyHttpClientLayer` back the native
 * container bootstrap itself (`start.handler.ts`): the fresh-volume `SetupLocalDatabase`-
 * equivalent pipeline runs its PG15+ one-shot migrate jobs through `LegacyDockerRun` and its
 * schema/globals/API-privileges SQL over a direct `LegacyDbConnection` session, and the health
 * wait (`legacyWaitForHealthyServices`) requires `HttpClient.HttpClient` in its type signature
 * even though `db start` never uses the PostgREST/Edge-Runtime gateway probes — same reasoning
 * as `start.command.ts`'s own composition of all three.
 *
 * `legacyEdgeRuntimeScriptLayer`/`legacyPgDeltaSslProbeLayer` back that same fresh-volume
 * pipeline's best-effort pg-delta migrations-catalog warmup (`db-setup.ts`'s
 * `legacyTryCacheMigrationsCatalog` call) — the exact same pair `db push` already composes
 * for its own call to that function (`push.layers.ts`).
 */
const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
const httpClient = legacyHttpClientLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
const edgeRuntime = legacyEdgeRuntimeScriptLayer.pipe(
  Layer.provide(legacyDockerRunLayer),
  Layer.provide(cliConfig),
);

export const legacyDbStartRuntimeLayer = Layer.mergeAll(
  cliConfig,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["db", "start"]),
  legacyDockerRunLayer,
  legacyDbConnectionLayer,
  httpClient,
  edgeRuntime,
  legacyPgDeltaSslProbeLayer,
);
