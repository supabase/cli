import { Layer } from "effect";

import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { legacyCredentialsLayer } from "../../../auth/legacy-credentials.layer.ts";
import { legacyHttpClientLayer } from "../../../auth/legacy-http-debug.layer.ts";
import { legacyPlatformApiFactoryLayer } from "../../../auth/legacy-platform-api-factory.layer.ts";
import { legacyCliConfigLayer } from "../../../config/legacy-cli-config.layer.ts";
import { legacyProjectRefLayer } from "../../../config/legacy-project-ref.layer.ts";
import { legacyDbConfigLayer } from "../../../shared/legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "../../../shared/legacy-db-connection.layer.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { legacyIdentityStitchLayer } from "../../../shared/legacy-identity-stitch.ts";
import { legacyLinkedProjectCacheLayer } from "../../../telemetry/legacy-linked-project-cache.layer.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";

/**
 * Runtime layer for `supabase db lint`, which spans local and linked DB access:
 *
 *   - **`--local` / `--db-url`** — the Postgres connection + db-config resolver.
 *   - **`--linked`** — direct DB connection via the db-config resolver's linked
 *     branch, plus project-ref resolution and the linked-project cache so the
 *     `--linked` run writes supabase/.temp/linked-project.json for telemetry
 *     grouping (Go's PersistentPostRun `ensureProjectGroupsCached`).
 *
 * Mirrors `advisors.layers.ts`. Deliberately does NOT use
 * `legacyManagementApiRuntimeLayer`: that layer exposes an *eagerly* built
 * `LegacyPlatformApi`, which resolves an access token at layer construction, so
 * merging it would make the auth-free `--local` path fail before the handler
 * runs (legacy CLAUDE.md item 5 / 7). The project-ref resolver is instead given
 * the **lazy** `legacyPlatformApiFactoryLayer`; the linked lint path resolves the
 * ref via the non-prompting `loadProjectRef`, which never forces the factory.
 *
 * `legacyCliConfigLayer` is provided to each consumer that needs it (item 5:
 * `Layer.provide` does not share to merge siblings); layers are memoised by
 * reference so the config / credentials / HTTP instances are reused.
 *
 * `legacyIdentityStitchLayer` (the one per-command identity stitcher) is provided
 * by the SAME reference to the platform-API factory, the linked-project cache, and
 * the db-config resolver, so memoisation gives all three a single `stitchAttempted`
 * guard — Go's one root-context `sync.Once`. The db-config resolver snapshots that
 * instance into its lazy linked stack's ambient layer.
 */
const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
const httpClient = legacyHttpClientLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
const credentials = legacyCredentialsLayer.pipe(
  Layer.provide(cliConfig),
  Layer.provide(legacyDebugLoggerLayer),
);

const platformApiFactory = legacyPlatformApiFactoryLayer.pipe(
  Layer.provide(credentials),
  Layer.provide(cliConfig),
  Layer.provide(legacyDebugLoggerLayer),
  Layer.provide(legacyIdentityStitchLayer),
);

const projectRef = legacyProjectRefLayer.pipe(
  Layer.provide(platformApiFactory),
  Layer.provide(cliConfig),
);

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
  Layer.provide(legacyIdentityStitchLayer),
);

export const legacyDbLintRuntimeLayer = Layer.mergeAll(
  dbConfig,
  legacyDbConnectionLayer,
  cliConfig,
  httpClient,
  credentials,
  projectRef,
  linkedProjectCache,
  // The one per-command identity stitcher (Go's single root-context `sync.Once`),
  // exposed at top level so `withLegacyCommandInstrumentation` can read
  // `stitchedDistinctId()` and attribute the cli_command_executed event to the
  // gotrue id. The SAME reference is provided to platformApiFactory /
  // linkedProjectCache / dbConfig above, so memoisation makes the linked
  // path, the cache GET, and the db-config stack all share one
  // `stitchAttempted` guard — aliasing/persisting at most once. Its
  // Analytics / TelemetryRuntime / FileSystem / Path deps are ambient (root
  // runtime). Mirrors advisors.layers.ts exactly.
  legacyIdentityStitchLayer,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["db", "lint"]),
);
