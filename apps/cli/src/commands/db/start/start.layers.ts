import { Layer } from "effect";
import { localDockerEngineLayer } from "../../../command-internal/db-bootstrap/local-db-running.ts";

import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { commandSettingsLayer } from "../../../config/command-settings.layer.ts";
import { httpClientLayer } from "../../../auth/http-debug.layer.ts";
import { dbConnectionLayer } from "../../../command-internal/db-connection.layer.ts";
import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { dockerRunLayer } from "../../../command-internal/docker-run.layer.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { stackApiLayer } from "../../experimental/stack/stack.shared.ts";

/**
 * Runtime layer for `supabase db start`, matching `supabase start`'s own composition.
 * `dockerRunLayer`/`dbConnectionLayer`/`httpClientLayer` back the native container
 * bootstrap: migrate jobs run through `DockerRun`, schema SQL over `DbConnection`, and the
 * health wait requires `HttpClient.HttpClient` in its signature even though `db start` never
 * uses the PostgREST/Edge-Runtime probes.
 */
const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));
const httpClient = httpClientLayer.pipe(Layer.provide(debugLoggerLayer));

export const dbStartRuntimeLayer = Layer.mergeAll(
  cliSettings,
  telemetryStateLayer,
  // Backs `isLocalDbRunning`'s direct Engine-API probe (+ its `--debug` trace).
  localDockerEngineLayer.pipe(Layer.provide(debugLoggerLayer)),
  commandRuntimeLayer(["db", "start"]),
  dockerRunLayer,
  dbConnectionLayer,
  httpClient,
  stackApiLayer,
);
