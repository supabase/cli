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
import { dockerRunLayer } from "../../../command-internal/docker-run.layer.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { identityStitchLayer } from "../../../command-internal/identity-stitch.ts";
import { linkedProjectCacheLayer } from "../../../telemetry/linked-project-cache.layer.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";

/**
 * Runtime layer for `supabase db reset`. Same composition as `db push` / `db lint`:
 * the Postgres connection, the db-config resolver, project-ref resolution, and the
 * linked-project cache, all over the lazy management-API factory so the local /
 * `--db-url` paths never resolve an access token at layer-build time. Both targets
 * are fully native (the local container-recreate primitives, and the remote
 * `--experimental` schema-files apply) — no Go delegation remains on this
 * command, so `GoProxy` is not composed here.
 *
 * `dockerRunLayer` backs the native local recreate's PG15+ one-shot migrate
 * jobs (`startSetupLocalDatabase`, reused via `recreateLocalDatabase`)
 * — same reasoning as `db start`'s own `start.layers.ts`.
 * `CommandSettings`/`ChildProcessSpawner`/`FileSystem`/`Path`/`RuntimeInfo` are
 * ambient from the root runtime (`shared/cli/run.ts`).
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

export const dbResetRuntimeLayer = Layer.mergeAll(
  dbConfig,
  dbConnectionLayer,
  cliSettings,
  httpClient,
  credentials,
  projectRef,
  // Exposed (not just provided to `projectRef`) because the local reset path reuses
  // the seed-buckets core, whose `resolveStorageCredentials` requires the
  // (lazy) Management-API factory for the linked branch — never hit on `--local`,
  // but a static service requirement of the shared core.
  platformApiFactory,
  linkedProjectCache,
  identityStitchLayer,
  telemetryStateLayer,
  // `promptYesNo`'s non-TTY branch reads the piped answer via `Stdin`;
  // without it a CI/piped remote `db reset` that reaches the confirmation
  // prompt fails with a missing-service defect instead of the default.
  stdinLayer,
  // Backs the native local recreate's PG15+ one-shot migrate jobs.
  dockerRunLayer,
  commandRuntimeLayer(["db", "reset"]),
);
