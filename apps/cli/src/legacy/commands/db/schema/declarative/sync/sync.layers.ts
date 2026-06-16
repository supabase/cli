import { Layer } from "effect";

import { commandRuntimeLayer } from "../../../../../../shared/runtime/command-runtime.layer.ts";
import { legacyCliConfigLayer } from "../../../../../config/legacy-cli-config.layer.ts";
import { legacyDbConfigLayer } from "../../../../../shared/legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "../../../../../shared/legacy-db-connection.layer.ts";
import { legacyDebugLoggerLayer } from "../../../../../shared/legacy-debug-logger.layer.ts";
import { legacyDockerRunLayer } from "../../../../../shared/legacy-docker-run.layer.ts";
import { legacyEdgeRuntimeScriptLayer } from "../../../../../shared/legacy-edge-runtime-script.layer.ts";
import { legacyTelemetryStateLayer } from "../../../../../telemetry/legacy-telemetry-state.layer.ts";
import { legacyDeclarativeSeamLayer } from "../declarative.seam.layer.ts";

/**
 * Runtime layer for `supabase db schema declarative sync`. Sync diffs against the
 * local database, but its no-declarative-files bootstrap delegates to the shared
 * smart-generate flow (Go's `runDeclarativeGenerate`), which can target local /
 * linked / custom — so it needs the db-config resolver too. `Output` /
 * `LegacyGoProxy` / global flags + the Bun platform come from the legacy root /
 * `runCli`.
 */
const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

const dbConfig = legacyDbConfigLayer.pipe(
  Layer.provide(cliConfig),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(legacyDebugLoggerLayer),
);

const edgeRuntime = legacyEdgeRuntimeScriptLayer.pipe(
  Layer.provide(legacyDockerRunLayer),
  Layer.provide(cliConfig),
);

const seam = legacyDeclarativeSeamLayer.pipe(Layer.provide(cliConfig));

export const legacyDbSchemaDeclarativeSyncRuntimeLayer = Layer.mergeAll(
  dbConfig,
  edgeRuntime,
  seam,
  legacyDbConnectionLayer,
  cliConfig,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["db", "schema", "declarative", "sync"]),
);
