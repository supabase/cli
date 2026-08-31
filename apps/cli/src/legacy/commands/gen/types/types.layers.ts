import { Layer } from "effect";

import { legacyCredentialsLayer } from "../../../auth/legacy-credentials.layer.ts";
import { legacyPlatformApiFactoryLayer } from "../../../auth/legacy-platform-api-factory.layer.ts";
import { LegacyPlatformApiFactory } from "../../../auth/legacy-platform-api-factory.service.ts";
import { legacyCliSettingsLayer } from "../../../config/legacy-cli-settings.layer.ts";
import { LegacyCliSettings } from "../../../config/legacy-cli-settings.service.ts";
import { legacyProjectRefLayer } from "../../../config/legacy-project-ref.layer.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { legacyDbConfigLayer } from "../../../shared/legacy-db-config.layer.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { legacyDbConnectionLayer } from "../../../shared/legacy-db-connection.layer.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import {
  LegacyIdentityStitch,
  legacyIdentityStitchLayer,
} from "../../../shared/legacy-identity-stitch.ts";
import { legacyHttpClientLayer } from "../../../auth/legacy-http-debug.layer.ts";
import { legacyLinkedProjectCacheLayer } from "../../../telemetry/legacy-linked-project-cache.layer.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { CommandRuntime } from "../../../../shared/runtime/command-runtime.service.ts";
import { legacyGenTypesGeneratorLayer } from "./types.generator.layer.ts";
import { LegacyGenTypesGenerator } from "./types.generator.ts";

/**
 * `gen types --local` and `--db-url` do not use the Management API, so this
 * runtime deliberately avoids `legacyManagementApiRuntimeLayer`: that layer
 * eagerly builds the platform API client and requires an access token before
 * the handler can choose the local/db-url branch.
 */
export const legacyGenTypesRuntimeLayer = (() => {
  const cliSettings = legacyCliSettingsLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
  const httpClient = legacyHttpClientLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
  const credentials = legacyCredentialsLayer.pipe(
    Layer.provide(cliSettings),
    Layer.provide(legacyDebugLoggerLayer),
  );
  // `legacyIdentityStitchLayer` (one per-command identity stitcher) is provided by
  // the SAME reference to the platform-API factory and the linked-project cache so
  // memoisation gives both a single `stitchAttempted` guard.
  const platformApiFactory = legacyPlatformApiFactoryLayer.pipe(
    Layer.provide(credentials),
    Layer.provide(cliSettings),
    Layer.provide(legacyDebugLoggerLayer),
    Layer.provide(legacyIdentityStitchLayer),
  );
  const dbConfig = legacyDbConfigLayer.pipe(
    Layer.provide(cliSettings),
    Layer.provide(legacyDbConnectionLayer),
    Layer.provide(legacyDebugLoggerLayer),
    Layer.provide(legacyIdentityStitchLayer),
  );

  const built = Layer.mergeAll(
    dbConfig,
    legacyDbConnectionLayer,
    cliSettings,
    platformApiFactory,
    legacyProjectRefLayer.pipe(Layer.provide(platformApiFactory), Layer.provide(cliSettings)),
    legacyLinkedProjectCacheLayer.pipe(
      Layer.provide(credentials),
      Layer.provide(cliSettings),
      Layer.provide(httpClient),
      Layer.provide(legacyIdentityStitchLayer),
    ),
    legacyGenTypesGeneratorLayer,
    legacyTelemetryStateLayer,
    // The one per-command identity stitcher, exposed at top level so
    // `withLegacyCommandInstrumentation` can read
    // `stitchedDistinctId()` and attribute the cli_command_executed event to the
    // gotrue id. The SAME reference is provided to platformApiFactory /
    // linkedProjectCache above, so memoisation gives both a single
    // `stitchAttempted` guard — aliasing/persisting at most once. Its
    // Analytics / TelemetryRuntime / FileSystem / Path deps are ambient (root
    // runtime). Mirrors advisors.layers.ts / lint.layers.ts.
    legacyIdentityStitchLayer,
    commandRuntimeLayer(["gen", "types"]),
  );

  const _serviceCoverageCheck: Layer.Layer<LegacyGenTypesServices, unknown, unknown> = built;
  void _serviceCoverageCheck;

  return built;
})();

type LegacyGenTypesServices =
  | LegacyPlatformApiFactory
  | LegacyCliSettings
  | LegacyProjectRefResolver
  | LegacyDbConfigResolver
  | LegacyGenTypesGenerator
  | LegacyLinkedProjectCache
  | LegacyTelemetryState
  | LegacyIdentityStitch
  | CommandRuntime;
