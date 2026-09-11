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
import { stackApiLayer } from "../../../command-internal/stack-api.ts";
/**
 * Runtime layer for `supabase db dump`.
 *
 * Mirrors `test db`'s composition: most of the Management API stack builds lazily
 * inside the resolver's `--linked` branch. `ProjectRefResolver` is exposed here (like
 * `db push`) so the handler can validate `--project-ref` before the linked-project-cache
 * finalizer sees it.
 */
const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));
const httpClient = httpClientLayer.pipe(Layer.provide(debugLoggerLayer));
const credentials = commandCredentialsLayer.pipe(
  Layer.provide(cliSettings),
  Layer.provide(debugLoggerLayer),
);

// The lazy `commandPlatformApiFactoryLayer` (not the eager management-API runtime)
// keeps dump's auth-free `--linked --password` path from resolving an access token
// at layer-build time, same as `db push`.
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
  // `IdentityStitch` is shared with the lazy platform-API factory and linked-project
  // cache, so it must be provided here too or the binary panics with a
  // missing-service error (CLAUDE.md invariant 5).
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
  // Exposed so native-engine dump can read `runtime.kind` and pick PATH pg_dump.
  stackApiLayer,
  commandRuntimeLayer(["db", "dump"]),
);
