import { Layer } from "effect";

import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { legacyCliConfigLayer } from "../../../config/legacy-cli-config.layer.ts";
import { legacyDbConfigLayer } from "../../../shared/legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "../../../shared/legacy-db-connection.layer.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";

/**
 * Runtime layer for `supabase db lint`.
 *
 * `db lint` is local / `--db-url` / `--linked`-direct-DB only — it never calls
 * the Management API — so this mirrors `legacyInspectBaseLayer`: the DB-config
 * resolver, the Postgres connection, the CLI config, and telemetry state, plus
 * the `["db", "lint"]` command-runtime identity for telemetry.
 *
 * `legacyCliConfigLayer` is provided to the resolver AND exposed at the top
 * level because `Layer.provide` does not share to merge siblings (legacy
 * CLAUDE.md item 5). The `--linked` branch of the resolver builds its own
 * Management API stack lazily, so no API stack is merged here.
 */
const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

const dbConfig = legacyDbConfigLayer.pipe(
  Layer.provide(cliConfig),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(legacyDebugLoggerLayer),
);

export const legacyDbLintRuntimeLayer = Layer.mergeAll(
  dbConfig,
  legacyDbConnectionLayer,
  cliConfig,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["db", "lint"]),
);
