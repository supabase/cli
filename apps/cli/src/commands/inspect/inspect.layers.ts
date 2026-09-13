import { Layer } from "effect";

import { commandSettingsLayer } from "../../config/command-settings.layer.ts";
import { dbConfigLayer } from "../../command-internal/db-config.layer.ts";
import { dbConnectionLayer } from "../../command-internal/db-connection.layer.ts";
import { identityStitchLayer } from "../../command-internal/identity-stitch.ts";
import { debugLoggerLayer } from "../../command-internal/debug-logger.layer.ts";
import { telemetryStateLayer } from "../../telemetry/telemetry-state.layer.ts";

// `Layer.provide` does not merge into sibling layers, so `commandSettingsLayer` is provided
// here (for `dbConfig`) and merged again below so both have it.
const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));

const dbConfig = dbConfigLayer.pipe(
  Layer.provide(cliSettings),
  Layer.provide(dbConnectionLayer),
  Layer.provide(debugLoggerLayer),
  Layer.provide(identityStitchLayer),
);

/**
 * The services every `inspect` leaf shares, minus the command-runtime identity: the DB-config
 * resolver, the Postgres connection, the CLI config, and telemetry state.
 *
 * The Management API stack is not merged here — it resolves an access token eagerly, which would
 * break the auth-free `--local` / `--db-url` paths. The `--linked` path provides it lazily
 * inside the resolver.
 */
export const inspectBaseLayer = Layer.mergeAll(
  dbConfig,
  dbConnectionLayer,
  cliSettings,
  // The same instance is provided to `dbConfig` above so both it and `withCommandTelemetry`
  // share one memoized identity-stitch attempt.
  identityStitchLayer,
  telemetryStateLayer,
);
