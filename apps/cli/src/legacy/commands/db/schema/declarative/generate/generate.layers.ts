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
 * Runtime layer for `supabase db schema declarative generate`.
 *
 * `Output` / `LegacyGoProxy` / global flags come from the legacy root; the Bun
 * platform (FileSystem / Path / ChildProcessSpawner / ProcessControl / Tty) from
 * `runCli`. This layer adds the declarative-specific services: the edge-runtime
 * pg-delta runner and the Go shadow-database seam, plus the db-config resolver
 * for `--linked` / `--db-url`. Per the "provide doesn't share to siblings" rule,
 * `LegacyCliConfig` is provided to every layer that needs it.
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

export const legacyDbSchemaDeclarativeGenerateRuntimeLayer = Layer.mergeAll(
  dbConfig,
  legacyDbConnectionLayer,
  edgeRuntime,
  seam,
  cliConfig,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["db", "schema", "declarative", "generate"]),
);
