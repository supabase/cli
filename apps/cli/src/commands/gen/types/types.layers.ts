import { Layer } from "effect";

import { commandCredentialsLayer } from "../../../auth/command-credentials.layer.ts";
import { commandPlatformApiFactoryLayer } from "../../../auth/command-platform-api-factory.layer.ts";
import { CommandPlatformApiFactory } from "../../../auth/command-platform-api-factory.service.ts";
import { commandSettingsLayer } from "../../../config/command-settings.layer.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { projectRefLayer } from "../../../config/project-ref.layer.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { dbConfigLayer } from "../../../command-internal/db-config.layer.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { dbConnectionLayer } from "../../../command-internal/db-connection.layer.ts";
import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { pgDeltaSslProbeLayer } from "../../../command-internal/pgdelta-ssl-probe.layer.ts";
import { PgDeltaSslProbe } from "../../../command-internal/pgdelta-ssl-probe.service.ts";
import { IdentityStitch, identityStitchLayer } from "../../../command-internal/identity-stitch.ts";
import { httpClientLayer } from "../../../auth/http-debug.layer.ts";
import { linkedProjectCacheLayer } from "../../../telemetry/linked-project-cache.layer.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { CommandRuntime } from "../../../shared/runtime/command-runtime.service.ts";

/**
 * Avoids `managementApiRuntimeLayer`, which eagerly builds the platform API client and
 * requires an access token before the handler can choose the local/db-url branch — `gen types
 * --local`/`--db-url` don't use the Management API.
 */
export const genTypesRuntimeLayer = (() => {
  const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));
  const httpClient = httpClientLayer.pipe(Layer.provide(debugLoggerLayer));
  const credentials = commandCredentialsLayer.pipe(
    Layer.provide(cliSettings),
    Layer.provide(debugLoggerLayer),
  );
  // The same `identityStitchLayer` reference is provided to the platform-API factory and the
  // linked-project cache so memoisation gives both a single `stitchAttempted` guard.
  const platformApiFactory = commandPlatformApiFactoryLayer.pipe(
    Layer.provide(credentials),
    Layer.provide(cliSettings),
    Layer.provide(debugLoggerLayer),
    Layer.provide(identityStitchLayer),
  );
  const dbConfig = dbConfigLayer.pipe(
    Layer.provide(cliSettings),
    Layer.provide(dbConnectionLayer),
    Layer.provide(debugLoggerLayer),
    Layer.provide(identityStitchLayer),
  );

  const built = Layer.mergeAll(
    dbConfig,
    dbConnectionLayer,
    cliSettings,
    platformApiFactory,
    projectRefLayer.pipe(Layer.provide(platformApiFactory), Layer.provide(cliSettings)),
    linkedProjectCacheLayer.pipe(
      Layer.provide(credentials),
      Layer.provide(cliSettings),
      Layer.provide(httpClient),
      Layer.provide(identityStitchLayer),
    ),
    pgDeltaSslProbeLayer,
    telemetryStateLayer,
    // Exposed at top level so `withCommandTelemetry` can read `stitchedDistinctId()` and
    // attribute the cli_command_executed event to the gotrue id.
    identityStitchLayer,
    commandRuntimeLayer(["gen", "types"]),
  );

  const _serviceCoverageCheck: Layer.Layer<GenTypesServices, unknown, unknown> = built;
  void _serviceCoverageCheck;

  return built;
})();

type GenTypesServices =
  | CommandPlatformApiFactory
  | CommandSettings
  | ProjectRefResolver
  | DbConfigResolver
  | PgDeltaSslProbe
  | LinkedProjectCache
  | TelemetryState
  | IdentityStitch
  | CommandRuntime;
