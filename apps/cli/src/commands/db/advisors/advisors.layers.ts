import { Layer } from "effect";

import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { commandCredentialsLayer } from "../../../auth/command-credentials.layer.ts";
import { httpClientLayer } from "../../../auth/http-debug.layer.ts";
import { commandPlatformApiFactoryLayer } from "../../../auth/command-platform-api-factory.layer.ts";
import { commandSettingsLayer } from "../../../config/command-settings.layer.ts";
import { projectRefLayer } from "../../../config/project-ref.layer.ts";
import { dbConfigLayer } from "../../../command-internal/db-config.layer.ts";
import { dbConnectionLayer } from "../../../command-internal/db-connection.layer.ts";
import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { identityStitchLayer } from "../../../command-internal/identity-stitch.ts";
import { linkedProjectCacheLayer } from "../../../telemetry/linked-project-cache.layer.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";

/**
 * Runtime layer for `supabase db advisors`, which spans two backends:
 *
 *   - **`--local` / `--db-url`** — the Postgres connection + db-config resolver.
 *   - **`--linked`** — raw-HTTP advisor GETs, project-ref resolution, and the
 *     linked-project cache.
 *
 * Does not use `managementApiRuntimeLayer`: that layer eagerly builds `CommandPlatformApi`,
 * resolving an access token at layer construction, which would make the auth-free `--local` path
 * fail with a "token not provided" error before the handler runs.
 *
 * Instead the project-ref resolver is given the lazy `commandPlatformApiFactoryLayer`, whose
 * `make` is only forced by an interactive project-ref prompt. The linked path resolves the ref
 * via the non-prompting `loadProjectRef`, which never forces the factory; the local path never
 * resolves a project ref at all, so no token is resolved there either.
 *
 * `commandSettingsLayer` is provided to each consumer that needs it, since `Layer.provide` does
 * not share to merge siblings; layers are memoised by reference so the config / credentials /
 * HTTP instances are reused.
 */
const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));
const httpClient = httpClientLayer.pipe(Layer.provide(debugLoggerLayer));
const credentials = commandCredentialsLayer.pipe(
  Layer.provide(cliSettings),
  Layer.provide(debugLoggerLayer),
);

const platformApiFactory = commandPlatformApiFactoryLayer.pipe(
  Layer.provide(credentials),
  Layer.provide(cliSettings),
  Layer.provide(debugLoggerLayer),
  Layer.provide(identityStitchLayer),
);

const projectRef = projectRefLayer.pipe(
  Layer.provide(platformApiFactory),
  Layer.provide(cliSettings),
);

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
  Layer.provide(identityStitchLayer),
);

export const dbAdvisorsRuntimeLayer = Layer.mergeAll(
  dbConfig,
  dbConnectionLayer,
  cliSettings,
  httpClient,
  credentials,
  projectRef,
  linkedProjectCache,
  // The one per-command identity stitcher, exposed at top level so the raw-HTTP advisor GETs can
  // yield it. The same reference is provided to platformApiFactory / linkedProjectCache /
  // dbConfig above, so memoisation makes them all share one `stitchAttempted` guard, firing at
  // most once.
  identityStitchLayer,
  telemetryStateLayer,
  commandRuntimeLayer(["db", "advisors"]),
);
