import { Layer } from "effect";

import { commandCredentialsLayer } from "../../../auth/command-credentials.layer.ts";
import { httpClientLayer } from "../../../auth/http-debug.layer.ts";
import { commandPlatformApiFactoryLayer } from "../../../auth/command-platform-api-factory.layer.ts";
import { commandSettingsLayer } from "../../../config/command-settings.layer.ts";
import { projectRefLayer } from "../../../config/project-ref.layer.ts";
import { dbConfigLayer } from "../../../command-internal/db-config.layer.ts";
import { dbConnectionLayer } from "../../../command-internal/db-connection.layer.ts";
import { dockerRunLayer } from "../../../command-internal/docker-run.layer.ts";
import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { identityStitchLayer } from "../../../command-internal/identity-stitch.ts";
import { linkedProjectCacheLayer } from "../../../telemetry/linked-project-cache.layer.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";

/**
 * Runtime layer for `supabase db dump`.
 *
 * Mirrors `test db`'s composition (`command-internal/test-db.layers.ts`): the
 * bulk of the Management API stack is still built lazily inside the resolver's
 * `--linked` branch. The one exception is `ProjectRefResolver`, exposed here
 * (same shape as `db push`, `push.layers.ts:40-50`) so the handler's up-front
 * `loadProjectRef` pre-capture can validate `--project-ref` before the
 * linked-project-cache finalizer ever sees it. The dump handler reaches the
 * database through a pg_dump container (`DockerRun`), never a direct
 * connection, but the resolver still needs `DbConnection` for the linked
 * pooler temp-role probe.
 */
const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));
const httpClient = httpClientLayer.pipe(Layer.provide(debugLoggerLayer));
const credentials = commandCredentialsLayer.pipe(
  Layer.provide(cliSettings),
  Layer.provide(debugLoggerLayer),
);

// Deliberately the **lazy** `commandPlatformApiFactoryLayer` (not the eager
// management-API runtime), so dump's auth-free `--linked --password` path never
// resolves an access token at layer-build time — same rationale as `db push`
// (`push.layers.ts:26-31`).
const platformApiFactory = commandPlatformApiFactoryLayer.pipe(
  Layer.provide(credentials),
  Layer.provide(cliSettings),
  Layer.provide(debugLoggerLayer),
  Layer.provide(identityStitchLayer),
);

// Exposed so the handler can pre-validate `--project-ref` via `loadProjectRef`
// before the linked-project-cache finalizer ever sees it.
const projectRef = projectRefLayer.pipe(
  Layer.provide(platformApiFactory),
  Layer.provide(cliSettings),
);

// Exposed so the handler can cache the linked project (GET /v1/projects/{ref})
// in its post-run finalizer. Shares the single `identityStitchLayer`.
const linkedProjectCache = linkedProjectCacheLayer.pipe(
  Layer.provide(credentials),
  Layer.provide(cliSettings),
  Layer.provide(httpClient),
  Layer.provide(identityStitchLayer),
);

const dbConfig = dbConfigLayer.pipe(
  Layer.provide(cliSettings),
  Layer.provide(dbConnectionLayer),
  Layer.provide(debugLoggerLayer),
  // The linked db-config resolver snapshots `IdentityStitch` (shared with
  // the lazy platform-API factory + linked-project cache), so the command
  // runtime must provide it or the bundled binary panics with a
  // missing-service error (legacy CLAUDE.md rule 5). Its Analytics / TelemetryRuntime
  // / FileSystem / Path deps are ambient from the root runtime.
  Layer.provide(identityStitchLayer),
);

export const dbDumpRuntimeLayer = Layer.mergeAll(
  dbConfig,
  dbConnectionLayer,
  dockerRunLayer,
  cliSettings,
  projectRef,
  linkedProjectCache,
  identityStitchLayer,
  telemetryStateLayer,
  commandRuntimeLayer(["db", "dump"]),
);
