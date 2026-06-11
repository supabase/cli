import { Layer } from "effect";

import { legacyCliConfigLayer } from "../../../config/legacy-cli-config.layer.ts";
import { legacyDbConfigLayer } from "../../../shared/legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "../../../shared/legacy-db-connection.layer.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";

/**
 * Runtime layer for the `supabase inspect db` subcommands.
 *
 * Mirrors `test/test.layers.ts` minus the docker layer: every subcommand needs
 * the DB-config resolver, the Postgres connection, the CLI config, telemetry
 * state, and the command-runtime identity. The Management API stack is NOT merged
 * here — it resolves an access token eagerly, which would break the auth-free
 * `--local` / `--db-url` paths. The `--linked` path provides it lazily inside the
 * resolver (`legacy-db-config.layer.ts`).
 *
 * `legacyCliConfigLayer` is provided to the resolver AND exposed at the top level
 * because `Layer.provide` does not share to merge siblings (legacy CLAUDE.md item
 * 5); the resolver requires it internally and so it is provided to `dbConfig`,
 * while the merge keeps it available alongside.
 */
const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

const dbConfig = legacyDbConfigLayer.pipe(
  Layer.provide(cliConfig),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(legacyDebugLoggerLayer),
);

export const legacyInspectDbRuntimeLayer = Layer.mergeAll(
  dbConfig,
  legacyDbConnectionLayer,
  cliConfig,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["inspect", "db"]),
);
