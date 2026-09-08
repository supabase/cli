import { Layer } from "effect";

import { commandSettingsLayer } from "../../../config/command-settings.layer.ts";
import { dbConfigLayer } from "../../../command-internal/db-config.layer.ts";
import { dbConnectionLayer } from "../../../command-internal/db-connection.layer.ts";
import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { identityStitchLayer } from "../../../command-internal/identity-stitch.ts";
import { linkedDbResolverRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { telemetryOutputFormatLayer } from "../../../telemetry/telemetry-output-format.layer.ts";
import { aiToolLayer } from "../../../shared/telemetry/ai-tool.layer.ts";
import { randomLayer } from "../../../shared/runtime/random.layer.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";

/**
 * Runtime layer for `supabase db query`.
 *
 * The `--local` / `--db-url` paths go through `DbConfigResolver` +
 * `DbConnection` (auth-free). The `--linked` path POSTs to the Management
 * API over raw HTTP, so it needs `CommandCredentials` / `HttpClient` /
 * `ProjectRefResolver` / `CommandSettings` (plus `TelemetryState` /
 * `CommandRuntime` / `LinkedProjectCache`) — supplied by
 * `linkedDbResolverRuntimeLayer`. That runtime exposes the access token
 * **lazily** via `CommandPlatformApiFactory` rather than the eager `CommandPlatformApi`
 * stack, so building the runtime resolves no token: `db query --local` /
 * `--db-url` run without a login (the handler's `--linked` branch checks
 * `getAccessToken` itself), matching the token requirement only kicking in
 * on the `--linked` path.
 */
const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));

const dbConfig = dbConfigLayer.pipe(
  Layer.provide(cliSettings),
  Layer.provide(dbConnectionLayer),
  Layer.provide(debugLoggerLayer),
  // The linked db-config resolver + the linked-resolver runtime both snapshot
  // the single `IdentityStitch`; provide the SAME layer reference to
  // each so Effect memoises one shared instance. Without it the bundled
  // binary panics with a missing-service error (legacy CLAUDE.md rule 5).
  Layer.provide(identityStitchLayer),
);

export const dbQueryRuntimeLayer = Layer.mergeAll(
  dbConfig,
  dbConnectionLayer,
  randomLayer,
  aiToolLayer,
  stdinLayer,
  telemetryOutputFormatLayer,
  identityStitchLayer,
  linkedDbResolverRuntimeLayer(["db", "query"]).pipe(Layer.provide(identityStitchLayer)),
);
