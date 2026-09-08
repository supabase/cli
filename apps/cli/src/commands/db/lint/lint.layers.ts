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
 * Runtime layer for `supabase db lint`, which spans local and linked DB access:
 *
 *   - **`--local` / `--db-url`** — the Postgres connection + db-config resolver.
 *   - **`--linked`** — direct DB connection via the db-config resolver's linked
 *     branch, plus project-ref resolution and the linked-project cache so the
 *     `--linked` run writes supabase/.temp/linked-project.json for telemetry
 *     grouping.
 *
 * Mirrors `advisors.layers.ts`. Deliberately does NOT use
 * `managementApiRuntimeLayer`: that layer exposes an *eagerly* built
 * `CommandPlatformApi`, which resolves an access token at layer construction, so
 * merging it would make the auth-free `--local` path fail before the handler
 * runs (legacy CLAUDE.md item 5 / 7). The project-ref resolver is instead given
 * the **lazy** `commandPlatformApiFactoryLayer`; the linked lint path resolves the
 * ref via the non-prompting `loadProjectRef`, which never forces the factory.
 *
 * `commandSettingsLayer` is provided to each consumer that needs it (item 5:
 * `Layer.provide` does not share to merge siblings); layers are memoised by
 * reference so the config / credentials / HTTP instances are reused.
 *
 * `identityStitchLayer` (the one per-command identity stitcher) is provided
 * by the SAME reference to the platform-API factory, the linked-project cache, and
 * the db-config resolver, so memoisation gives all three a single
 * `stitchAttempted` guard. The db-config resolver snapshots that instance
 * into its lazy linked stack's ambient layer.
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

export const dbLintRuntimeLayer = Layer.mergeAll(
  dbConfig,
  dbConnectionLayer,
  cliSettings,
  httpClient,
  credentials,
  projectRef,
  linkedProjectCache,
  // The one per-command identity stitcher, exposed at top level so
  // `withCommandTelemetry` can read
  // `stitchedDistinctId()` and attribute the cli_command_executed event to the
  // gotrue id. The SAME reference is provided to platformApiFactory /
  // linkedProjectCache / dbConfig above, so memoisation makes the linked
  // path, the cache GET, and the db-config stack all share one
  // `stitchAttempted` guard — aliasing/persisting at most once. Its
  // Analytics / TelemetryRuntime / FileSystem / Path deps are ambient (root
  // runtime). Mirrors advisors.layers.ts exactly.
  identityStitchLayer,
  telemetryStateLayer,
  commandRuntimeLayer(["db", "lint"]),
);
