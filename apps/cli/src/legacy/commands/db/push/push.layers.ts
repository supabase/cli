import { Layer } from "effect";

import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { legacyCredentialsLayer } from "../../../auth/legacy-credentials.layer.ts";
import { legacyHttpClientLayer } from "../../../auth/legacy-http-debug.layer.ts";
import { legacyPlatformApiFactoryLayer } from "../../../auth/legacy-platform-api-factory.layer.ts";
import { legacyCliSettingsLayer } from "../../../config/legacy-cli-settings.layer.ts";
import { legacyProjectRefLayer } from "../../../config/legacy-project-ref.layer.ts";
import { legacyDbConfigLayer } from "../../../shared/legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "../../../shared/legacy-db-connection.layer.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { stdinLayer } from "../../../../shared/runtime/stdin.layer.ts";
import { legacyIdentityStitchLayer } from "../../../shared/legacy-identity-stitch.ts";
import { legacyLinkedProjectCacheLayer } from "../../../telemetry/legacy-linked-project-cache.layer.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";

/**
 * Runtime layer for `supabase db push`. Same shape as `db lint`: it spans local
 * (`--local` / `--db-url`) and linked DB access, so it composes the Postgres
 * connection, the db-config resolver, project-ref resolution, and the
 * linked-project cache.
 *
 * Like `db lint`, it deliberately uses the **lazy** `legacyPlatformApiFactoryLayer`
 * (not the eager management-API runtime) so the auth-free `--local` path never
 * resolves an access token at layer-build time. `legacyCliSettingsLayer` is provided
 * to each consumer that needs it (legacy CLAUDE.md item 5); the single
 * `legacyIdentityStitchLayer` reference is shared so the factory, the cache, and
 * the db-config resolver share one `stitchAttempted` guard.
 */
const cliSettings = legacyCliSettingsLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
const httpClient = legacyHttpClientLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
const credentials = legacyCredentialsLayer.pipe(
  Layer.provide(cliSettings),
  Layer.provide(legacyDebugLoggerLayer),
);

const platformApiFactory = legacyPlatformApiFactoryLayer.pipe(
  Layer.provide(credentials),
  Layer.provide(cliSettings),
  Layer.provide(legacyDebugLoggerLayer),
  Layer.provide(legacyIdentityStitchLayer),
);

const projectRef = legacyProjectRefLayer.pipe(
  Layer.provide(platformApiFactory),
  Layer.provide(cliSettings),
);

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
  Layer.provide(legacyIdentityStitchLayer),
);

export const legacyDbPushRuntimeLayer = Layer.mergeAll(
  dbConfig,
  legacyDbConnectionLayer,
  cliSettings,
  httpClient,
  credentials,
  projectRef,
  linkedProjectCache,
  legacyIdentityStitchLayer,
  legacyTelemetryStateLayer,
  // `legacyPromptYesNo`'s non-TTY branch reads the piped answer via `Stdin`;
  // without it a CI/piped `db push` that reaches a confirmation prompt fails
  // with a missing-service defect instead of honoring `y`/`n` or the default.
  stdinLayer,
  commandRuntimeLayer(["db", "push"]),
);
