import { Layer } from "effect";

import { legacyCliConfigLayer } from "../../config/legacy-cli-config.layer.ts";
import { legacyDbConfigLayer } from "../../shared/legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "../../shared/legacy-db-connection.layer.ts";
import { legacyDockerRunLayer } from "../../shared/legacy-docker-run.layer.ts";
import { legacyDebugLoggerLayer } from "../../shared/legacy-debug-logger.layer.ts";
import { legacyTelemetryStateLayer } from "../../telemetry/legacy-telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";

/**
 * Runtime layer for `supabase test db`.
 *
 * The Management API stack is intentionally NOT merged here: it resolves an
 * access token eagerly at build, which would break the auth-free `--local` /
 * `--db-url` paths. The `--linked` path provides it lazily inside the resolver
 * (`legacy-db-config.layer.ts`), so this layer only exposes the always-needed,
 * auth-free services. `legacyCliConfigLayer` is provided to the resolver AND
 * exposed at the top level (the handler yields it; `Layer.provide` does not
 * share to merge siblings — legacy CLAUDE.md item 5).
 */
const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

const dbConfig = legacyDbConfigLayer.pipe(
  Layer.provide(cliConfig),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(legacyDebugLoggerLayer),
);

export const legacyTestDbRuntimeLayer = Layer.mergeAll(
  dbConfig,
  legacyDbConnectionLayer,
  legacyDockerRunLayer,
  cliConfig,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["test", "db"]),
);
