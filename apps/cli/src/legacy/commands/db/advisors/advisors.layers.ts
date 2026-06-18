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
 * Runtime layer for `supabase db advisors`, which spans two backends:
 *
 *   - **`--local` / `--db-url`** — the Postgres connection + db-config resolver.
 *   - **`--linked`** — raw-HTTP advisor GETs, project-ref resolution, and the
 *     linked-project cache.
 *
 * Deliberately does NOT use `legacyManagementApiRuntimeLayer`: that layer exposes
 * an *eagerly* built `LegacyPlatformApi`, which resolves an access token at layer
 * construction. Merging it would make the auth-free `--local` path fail with a
 * "token not provided" error before the handler runs (caught by the bundled-binary
 * smoke test — legacy CLAUDE.md item 5 / 7).
 *
 * Instead the project-ref resolver is given the **lazy** `legacyPlatformApiFactoryLayer`,
 * whose `make` is only forced by an interactive project-ref prompt. advisors only
 * ever calls `resolve(Option.none())` (Go's soft `LoadProjectRef`), so no token is
 * resolved on the local path; the linked path resolves it explicitly in the handler.
 *
 * `legacyCliConfigLayer` is provided to each consumer that needs it (item 5:
 * `Layer.provide` does not share to merge siblings); layers are memoised by
 * reference so the config / credentials / HTTP instances are reused. Ambient
 * services (`Analytics`, `RuntimeInfo`, `FileSystem`, `Output`, `Tty`, …) are
 * satisfied by the root runtime.
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

export const legacyDbAdvisorsRuntimeLayer = Layer.mergeAll(
  dbConfig,
  legacyDbConnectionLayer,
  cliConfig,
  httpClient,
  credentials,
  projectRef,
  linkedProjectCache,
  // The one per-command identity stitcher (Go's single root-context `sync.Once`),
  // exposed at top level so the raw-HTTP advisor GETs can yield it. The SAME
  // reference is provided to platformApiFactory / linkedProjectCache / dbConfig
  // above, so memoisation makes the typed temp-role mint, the advisor GETs, the
  // cache GET, and the linked DB-config stack all share one `stitchAttempted`
  // guard — aliasing/persisting at most once. Its Analytics / TelemetryRuntime /
  // FileSystem / Path deps are ambient (root runtime).
  legacyIdentityStitchLayer,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["db", "advisors"]),
);
