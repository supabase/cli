import { Layer } from "effect";

import { legacyCredentialsLayer } from "../../../auth/legacy-credentials.layer.ts";
import { legacyHttpClientLayer } from "../../../auth/legacy-http-debug.layer.ts";
import { legacyCliConfigLayer } from "../../../config/legacy-cli-config.layer.ts";
import { legacyDbConfigLayer } from "../../../shared/legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "../../../shared/legacy-db-connection.layer.ts";
import { legacyDockerRunLayer } from "../../../shared/legacy-docker-run.layer.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { legacyIdentityStitchLayer } from "../../../shared/legacy-identity-stitch.ts";
import { legacyLinkedProjectCacheLayer } from "../../../telemetry/legacy-linked-project-cache.layer.ts";
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
const httpClient = legacyHttpClientLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
const credentials = legacyCredentialsLayer.pipe(
  Layer.provide(cliConfig),
  Layer.provide(legacyDebugLoggerLayer),
);

// Exposed so the handler can cache the linked project (GET /v1/projects/{ref}) in
// its post-run finalizer — Go's `ensureProjectGroupsCached` (cmd/root.go:214-234).
// Shares the single `legacyIdentityStitchLayer` (Go's one `sync.Once`).
const linkedProjectCache = legacyLinkedProjectCacheLayer.pipe(
  Layer.provide(credentials),
  Layer.provide(cliConfig),
  Layer.provide(httpClient),
  Layer.provide(legacyIdentityStitchLayer),
);

const dbConfig = legacyDbConfigLayer.pipe(
  Layer.provide(cliConfig),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(legacyDebugLoggerLayer),
  // The linked db-config resolver snapshots `LegacyIdentityStitch` (shared with the
  // lazy platform-API factory + linked-project cache, Go's single `sync.Once`), so
  // the command runtime must provide it or the bundled binary panics with a
  // missing-service error (legacy CLAUDE.md rule 5). Its Analytics / TelemetryRuntime
  // / FileSystem / Path deps are ambient from the root runtime.
  Layer.provide(legacyIdentityStitchLayer),
);

export const legacyDbDumpRuntimeLayer = Layer.mergeAll(
  dbConfig,
  legacyDbConnectionLayer,
  legacyDockerRunLayer,
  cliConfig,
  linkedProjectCache,
  legacyIdentityStitchLayer,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["db", "dump"]),
);
