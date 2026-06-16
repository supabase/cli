import { Layer } from "effect";

import { commandRuntimeLayer } from "../../../../../../shared/runtime/command-runtime.layer.ts";
import { legacyCliConfigLayer } from "../../../../../config/legacy-cli-config.layer.ts";
import { legacyDbConnectionLayer } from "../../../../../shared/legacy-db-connection.layer.ts";
import { legacyDebugLoggerLayer } from "../../../../../shared/legacy-debug-logger.layer.ts";
import { legacyDockerRunLayer } from "../../../../../shared/legacy-docker-run.layer.ts";
import { legacyEdgeRuntimeScriptLayer } from "../../../../../shared/legacy-edge-runtime-script.layer.ts";
import { legacyTelemetryStateLayer } from "../../../../../telemetry/legacy-telemetry-state.layer.ts";
import { legacyDeclarativeSeamLayer } from "../declarative.seam.layer.ts";

/**
 * Runtime layer for `supabase db schema declarative sync`. Sync always works
 * against the local database (no `--linked`/`--db-url`), so it needs no
 * db-config resolver — just the edge-runtime pg-delta runner and the Go
 * shadow-database seam. `Output` / `LegacyGoProxy` / global flags + the Bun
 * platform come from the legacy root / `runCli`.
 */
const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

const edgeRuntime = legacyEdgeRuntimeScriptLayer.pipe(
  Layer.provide(legacyDockerRunLayer),
  Layer.provide(cliConfig),
);

const seam = legacyDeclarativeSeamLayer.pipe(Layer.provide(cliConfig));

export const legacyDbSchemaDeclarativeSyncRuntimeLayer = Layer.mergeAll(
  edgeRuntime,
  seam,
  legacyDbConnectionLayer,
  cliConfig,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["db", "schema", "declarative", "sync"]),
);
