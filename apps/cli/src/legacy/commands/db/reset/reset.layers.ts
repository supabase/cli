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
import { stdinLayer } from "../../../../shared/runtime/stdin.layer.ts";
import { legacyIdentityStitchLayer } from "../../../shared/legacy-identity-stitch.ts";
import { legacyLinkedProjectCacheLayer } from "../../../telemetry/legacy-linked-project-cache.layer.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";
import { legacyDbBootstrapSeamLayer } from "../shared/legacy-db-bootstrap.seam.layer.ts";

/**
 * Runtime layer for `supabase db reset`. Same composition as `db push` / `db lint`:
 * the Postgres connection, the db-config resolver, project-ref resolution, and the
 * linked-project cache, all over the lazy management-API factory so the local /
 * `--db-url` paths never resolve an access token at layer-build time. `LegacyGoProxy`
 * (used to delegate the local / experimental reset paths) is ambient from the root.
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

export const legacyDbResetRuntimeLayer = Layer.mergeAll(
  dbConfig,
  legacyDbConnectionLayer,
  cliConfig,
  httpClient,
  credentials,
  projectRef,
  // Exposed (not just provided to `projectRef`) because the local reset path reuses
  // the seed-buckets core, whose `legacyResolveStorageCredentials` requires the
  // (lazy) Management-API factory for the linked branch — never hit on `--local`,
  // but a static service requirement of the shared core.
  platformApiFactory,
  linkedProjectCache,
  legacyIdentityStitchLayer,
  legacyTelemetryStateLayer,
  // `legacyPromptYesNo`'s non-TTY branch reads the piped answer via `Stdin` (Go's
  // `console.ReadLine`); without it a CI/piped remote `db reset` that reaches the
  // confirmation prompt fails with a missing-service defect instead of the default.
  stdinLayer,
  // Container-recreate / storage-health primitives for the native local reset.
  legacyDbBootstrapSeamLayer.pipe(Layer.provide(cliConfig)),
  commandRuntimeLayer(["db", "reset"]),
);
