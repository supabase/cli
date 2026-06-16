import { Layer } from "effect";

import { legacyCliConfigLayer } from "../../../config/legacy-cli-config.layer.ts";
import { legacyDbConfigLayer } from "../../../shared/legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "../../../shared/legacy-db-connection.layer.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { aiToolLayer } from "../../../../shared/telemetry/ai-tool.layer.ts";
import { randomLayer } from "../../../../shared/runtime/random.layer.ts";
import { stdinLayer } from "../../../../shared/runtime/stdin.layer.ts";

/**
 * Runtime layer for `supabase db query`.
 *
 * The `--local` / `--db-url` paths go through `LegacyDbConfigResolver` +
 * `LegacyDbConnection` (auth-free). The `--linked` path POSTs to the Management
 * API over raw HTTP, so it needs `LegacyCredentials` / `HttpClient` /
 * `LegacyProjectRefResolver` / `LegacyCliConfig` — supplied by
 * `legacyManagementApiRuntimeLayer`, which also provides `LegacyTelemetryState`
 * and `CommandRuntime`. The token is resolved lazily (only when `--linked` calls
 * `getAccessToken`), so the auth-free paths still work without a login.
 */
const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

const dbConfig = legacyDbConfigLayer.pipe(
  Layer.provide(cliConfig),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(legacyDebugLoggerLayer),
);

export const legacyDbQueryRuntimeLayer = Layer.mergeAll(
  dbConfig,
  legacyDbConnectionLayer,
  randomLayer,
  aiToolLayer,
  stdinLayer,
  legacyManagementApiRuntimeLayer(["db", "query"]),
);
