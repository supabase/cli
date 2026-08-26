import { Layer } from "effect";

import { legacyCredentialsLayer } from "../../../auth/legacy-credentials.layer.ts";
import { legacyHttpClientLayer } from "../../../auth/legacy-http-debug.layer.ts";
import { legacyPlatformApiFactoryLayer } from "../../../auth/legacy-platform-api-factory.layer.ts";
import { legacyCliSettingsLayer } from "../../../config/legacy-cli-settings.layer.ts";
import { legacyProjectRefLayer } from "../../../config/legacy-project-ref.layer.ts";
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
 * Mirrors `test db`'s composition (`legacy/shared/legacy-test-db.layers.ts`): the
 * bulk of the Management API stack is still built lazily inside the resolver's
 * `--linked` branch. The one exception is `LegacyProjectRefResolver`, exposed here
 * (same shape as `db push`, `push.layers.ts:40-50`) so the handler's up-front
 * `loadProjectRef` pre-capture can validate `--project-ref` before the
 * linked-project-cache finalizer ever sees it. The dump handler reaches the
 * database through a pg_dump container (`LegacyDockerRun`), never a direct
 * connection, but the resolver still needs `LegacyDbConnection` for the linked
 * pooler temp-role probe.
 */
const cliSettings = legacyCliSettingsLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
const httpClient = legacyHttpClientLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
const credentials = legacyCredentialsLayer.pipe(
  Layer.provide(cliSettings),
  Layer.provide(legacyDebugLoggerLayer),
);

// Deliberately the **lazy** `legacyPlatformApiFactoryLayer` (not the eager
// management-API runtime), so dump's auth-free `--linked --password` path never
// resolves an access token at layer-build time — same rationale as `db push`
// (`push.layers.ts:26-31`).
const platformApiFactory = legacyPlatformApiFactoryLayer.pipe(
  Layer.provide(credentials),
  Layer.provide(cliSettings),
  Layer.provide(legacyDebugLoggerLayer),
  Layer.provide(legacyIdentityStitchLayer),
);

// Exposed so the handler can pre-validate `--project-ref` via `loadProjectRef`
// before the linked-project-cache finalizer ever sees it.
const projectRef = legacyProjectRefLayer.pipe(
  Layer.provide(platformApiFactory),
  Layer.provide(cliSettings),
);

// Exposed so the handler can cache the linked project (GET /v1/projects/{ref})
// in its post-run finalizer. Shares the single `legacyIdentityStitchLayer`.
const linkedProjectCache = legacyLinkedProjectCacheLayer.pipe(
  Layer.provide(credentials),
  Layer.provide(cliSettings),
  Layer.provide(httpClient),
  Layer.provide(legacyIdentityStitchLayer),
);

const dbConfig = legacyDbConfigLayer.pipe(
  Layer.provide(cliSettings),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(legacyDebugLoggerLayer),
  // The linked db-config resolver snapshots `LegacyIdentityStitch` (shared with
  // the lazy platform-API factory + linked-project cache), so the command
  // runtime must provide it or the bundled binary panics with a
  // missing-service error (legacy CLAUDE.md rule 5). Its Analytics / TelemetryRuntime
  // / FileSystem / Path deps are ambient from the root runtime.
  Layer.provide(legacyIdentityStitchLayer),
);

export const legacyDbDumpRuntimeLayer = Layer.mergeAll(
  dbConfig,
  legacyDbConnectionLayer,
  legacyDockerRunLayer,
  cliSettings,
  projectRef,
  linkedProjectCache,
  legacyIdentityStitchLayer,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["db", "dump"]),
);
