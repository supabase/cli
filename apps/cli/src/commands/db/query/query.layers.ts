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
 * The `--local`/`--db-url` paths go through `DbConfigResolver` + `DbConnection` (auth-free). The
 * `--linked` path POSTs to the Management API, supplied by `linkedDbResolverRuntimeLayer`, which
 * exposes the access token lazily so building the runtime resolves no token — `--local`/`--db-url`
 * run without a login, since only the handler's `--linked` branch checks `getAccessToken`.
 */
const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));

const dbConfig = dbConfigLayer.pipe(
  Layer.provide(cliSettings),
  Layer.provide(dbConnectionLayer),
  Layer.provide(debugLoggerLayer),
  // The linked db-config resolver and the linked-resolver runtime both need the same
  // `IdentityStitch` instance; provide the same layer reference to each so Effect memoizes it.
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
