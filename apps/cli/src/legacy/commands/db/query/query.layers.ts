import { Layer } from "effect";

import { legacyCliConfigLayer } from "../../../config/legacy-cli-config.layer.ts";
import { legacyDbConfigLayer } from "../../../shared/legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "../../../shared/legacy-db-connection.layer.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { legacyIdentityStitchLayer } from "../../../shared/legacy-identity-stitch.ts";
import { legacyLinkedDbResolverRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { legacyTelemetryOutputFormatLayer } from "../../../telemetry/legacy-telemetry-output-format.layer.ts";
import { aiToolLayer } from "../../../../shared/telemetry/ai-tool.layer.ts";
import { randomLayer } from "../../../../shared/runtime/random.layer.ts";
import { stdinLayer } from "../../../../shared/runtime/stdin.layer.ts";

/**
 * Runtime layer for `supabase db query`.
 *
 * The `--local` / `--db-url` paths go through `LegacyDbConfigResolver` +
 * `LegacyDbConnection` (auth-free). The `--linked` path POSTs to the Management
 * API over raw HTTP, so it needs `LegacyCredentials` / `HttpClient` /
 * `LegacyProjectRefResolver` / `LegacyCliConfig` (plus `LegacyTelemetryState` /
 * `CommandRuntime` / `LegacyLinkedProjectCache`) — supplied by
 * `legacyLinkedDbResolverRuntimeLayer`. That runtime exposes the access token
 * **lazily** via `LegacyPlatformApiFactory` rather than the eager `LegacyPlatformApi`
 * stack, so building the runtime resolves no token: `db query --local` /
 * `--db-url` run without a login (the handler's `--linked` branch checks
 * `getAccessToken` itself), matching Go, which only requires the token in the
 * `--linked` PreRun.
 */
const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

const dbConfig = legacyDbConfigLayer.pipe(
  Layer.provide(cliConfig),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(legacyDebugLoggerLayer),
  // The linked db-config resolver + the linked-resolver runtime both snapshot the
  // single `LegacyIdentityStitch` (Go's one `sync.Once`); provide the SAME layer
  // reference to each so Effect memoises one shared instance. Without it the
  // bundled binary panics with a missing-service error (legacy CLAUDE.md rule 5).
  Layer.provide(legacyIdentityStitchLayer),
);

export const legacyDbQueryRuntimeLayer = Layer.mergeAll(
  dbConfig,
  legacyDbConnectionLayer,
  randomLayer,
  aiToolLayer,
  stdinLayer,
  legacyTelemetryOutputFormatLayer,
  legacyIdentityStitchLayer,
  legacyLinkedDbResolverRuntimeLayer(["db", "query"]).pipe(
    Layer.provide(legacyIdentityStitchLayer),
  ),
);
