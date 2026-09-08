import { Layer } from "effect";

import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { commandSettingsLayer } from "../../../config/command-settings.layer.ts";
import { httpClientLayer } from "../../../auth/http-debug.layer.ts";
import { dbConnectionLayer } from "../../../command-internal/db-connection.layer.ts";
import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { dockerRunLayer } from "../../../command-internal/docker-run.layer.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";

/**
 * Runtime layer for `supabase db start`. `CommandSettings`/`ChildProcessSpawner`/
 * `FileSystem`/`Path` are ambient from the root runtime (`shared/cli/run.ts`), matching
 * `supabase start`'s own layer composition (`start.command.ts`).
 *
 * No `DbBootstrapSeam` composition — that hidden `db __db-bootstrap` seam no
 * longer exists at all: `isLocalDbRunning` (the already-running check) and
 * `startDatabase` (the container bring-up itself) are both native TS,
 * hoisted to `command-internal/db-bootstrap/`. `db reset --local` is ALSO fully
 * native now, via its own composition over the same primitives (`reset.layers.ts`).
 *
 * `dockerRunLayer`/`dbConnectionLayer`/`httpClientLayer` back the native
 * container bootstrap itself (`start.handler.ts`): the fresh-volume `SetupLocalDatabase`-
 * equivalent pipeline runs its PG15+ one-shot migrate jobs through `DockerRun` and its
 * schema/globals/API-privileges SQL over a direct `DbConnection` session, and the health
 * wait (`waitForHealthyServices`) requires `HttpClient.HttpClient` in its type signature
 * even though `db start` never uses the PostgREST/Edge-Runtime gateway probes — same reasoning
 * as `start.command.ts`'s own composition of all three.
 */
const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));
const httpClient = httpClientLayer.pipe(Layer.provide(debugLoggerLayer));

export const dbStartRuntimeLayer = Layer.mergeAll(
  cliSettings,
  telemetryStateLayer,
  commandRuntimeLayer(["db", "start"]),
  dockerRunLayer,
  dbConnectionLayer,
  httpClient,
);
