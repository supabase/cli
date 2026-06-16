import { Layer } from "effect";

import { legacyCliConfigLayer } from "../../../config/legacy-cli-config.layer.ts";
import { legacyDbConfigLayer } from "../../../shared/legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "../../../shared/legacy-db-connection.layer.ts";
import { legacyDockerRunLayer } from "../../../shared/legacy-docker-run.layer.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";

/**
 * Runtime layer for `supabase db dump`.
 *
 * Mirrors `test db`'s composition (`commands/test/test.layers.ts`): the
 * Management API stack is built lazily inside the resolver's `--linked` branch,
 * so this layer only exposes the always-needed, auth-free services. The dump
 * handler reaches the database through a pg_dump container (`LegacyDockerRun`),
 * never a direct connection, but the resolver still needs `LegacyDbConnection`
 * for the linked pooler temp-role probe.
 */
const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

const dbConfig = legacyDbConfigLayer.pipe(
  Layer.provide(cliConfig),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(legacyDebugLoggerLayer),
);

export const legacyDbDumpRuntimeLayer = Layer.mergeAll(
  dbConfig,
  legacyDbConnectionLayer,
  legacyDockerRunLayer,
  cliConfig,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["db", "dump"]),
);
