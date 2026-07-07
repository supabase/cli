import { Layer } from "effect";

import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { legacyCliConfigLayer } from "../../../config/legacy-cli-config.layer.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";
import { legacyDbBootstrapSeamLayer } from "../shared/legacy-db-bootstrap.seam.layer.ts";

/**
 * Runtime layer for `supabase db start`. The command is local-only, so it needs
 * far less than the remote-capable db commands: just the container-bootstrap seam
 * (`db __db-bootstrap`), the CLI config (workdir + project id), and the telemetry
 * flush. The seam's other dependencies (`LegacyNetworkIdFlag`, `LegacyProfileFlag`,
 * `ChildProcessSpawner`, `FileSystem`, `Path`) are ambient from the root runtime,
 * matching how `db diff` composes the `db __shadow` seam. `LegacyCliConfig` is
 * provided to the seam explicitly (legacy CLAUDE.md rule 5).
 */
const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

const seam = legacyDbBootstrapSeamLayer.pipe(Layer.provide(cliConfig));

export const legacyDbStartRuntimeLayer = Layer.mergeAll(
  seam,
  cliConfig,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["db", "start"]),
);
