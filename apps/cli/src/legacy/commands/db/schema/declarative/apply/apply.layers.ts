import { Layer } from "effect";

import { commandRuntimeLayer } from "../../../../../../shared/runtime/command-runtime.layer.ts";
import { legacyCliConfigLayer } from "../../../../../config/legacy-cli-config.layer.ts";
import { legacyDebugLoggerLayer } from "../../../../../shared/legacy-debug-logger.layer.ts";
import { legacyDockerRunLayer } from "../../../../../shared/legacy-docker-run.layer.ts";
import { legacyEdgeRuntimeScriptLayer } from "../../../../../shared/legacy-edge-runtime-script.layer.ts";
import { legacyPgDeltaSslProbeLayer } from "../../../../../shared/legacy-pgdelta-ssl-probe.layer.ts";
import { legacyTelemetryStateLayer } from "../../../../../telemetry/legacy-telemetry-state.layer.ts";
import { legacyDeclarativeSeamLayer } from "../../../shared/legacy-pgdelta.seam.layer.ts";

const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

const edgeRuntime = legacyEdgeRuntimeScriptLayer.pipe(
  Layer.provide(legacyDockerRunLayer),
  Layer.provide(cliConfig),
);

const seam = legacyDeclarativeSeamLayer.pipe(Layer.provide(cliConfig));

export const legacyDbSchemaDeclarativeApplyRuntimeLayer = Layer.mergeAll(
  edgeRuntime,
  legacyPgDeltaSslProbeLayer,
  seam,
  cliConfig,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["db", "schema", "declarative", "apply"]),
);
