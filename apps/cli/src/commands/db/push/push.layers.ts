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
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { identityStitchLayer } from "../../../command-internal/identity-stitch.ts";
import { linkedProjectCacheLayer } from "../../../telemetry/linked-project-cache.layer.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";

/**
 * Runtime layer for `supabase db push`. Same shape as `db lint`: it spans local
 * (`--local` / `--db-url`) and linked DB access, so it composes the Postgres
 * connection, the db-config resolver, project-ref resolution, and the
 * linked-project cache.
 *
 * Like `db lint`, it uses the lazy `commandPlatformApiFactoryLayer` (not the eager
 * management-API runtime) so the auth-free `--local` path never resolves an access
 * token at layer-build time. `commandSettingsLayer` is provided to each consumer that
 * needs it (CLAUDE.md invariant 5); the single `identityStitchLayer` reference is
 * shared so the factory, the cache, and the db-config resolver share one
 * `stitchAttempted` guard.
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

export const dbPushRuntimeLayer = Layer.mergeAll(
  dbConfig,
  dbConnectionLayer,
  cliSettings,
  httpClient,
  credentials,
  projectRef,
  linkedProjectCache,
  identityStitchLayer,
  telemetryStateLayer,
  // `promptYesNo`'s non-TTY branch reads the piped answer via `Stdin`;
  // without it a CI/piped `db push` that reaches a confirmation prompt fails
  // with a missing-service defect instead of honoring `y`/`n` or the default.
  stdinLayer,
  commandRuntimeLayer(["db", "push"]),
);
