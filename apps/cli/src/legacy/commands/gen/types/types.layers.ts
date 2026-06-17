import { Layer } from "effect";

import { legacyCredentialsLayer } from "../../../auth/legacy-credentials.layer.ts";
import { legacyPlatformApiFactoryLayer } from "../../../auth/legacy-platform-api-factory.layer.ts";
import { LegacyPlatformApiFactory } from "../../../auth/legacy-platform-api-factory.service.ts";
import { legacyCliConfigLayer } from "../../../config/legacy-cli-config.layer.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { legacyProjectRefLayer } from "../../../config/legacy-project-ref.layer.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
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

/**
 * `gen types --local` and `--db-url` do not use the Management API, so this
 * runtime deliberately avoids `legacyManagementApiRuntimeLayer`: that layer
 * eagerly builds the platform API client and requires an access token before
 * the handler can choose the local/db-url branch.
 */
export const legacyGenTypesRuntimeLayer = (() => {
  const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
  const httpClient = legacyHttpClientLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
  const credentials = legacyCredentialsLayer.pipe(
    Layer.provide(cliConfig),
    Layer.provide(legacyDebugLoggerLayer),
  );
  // `legacyIdentityStitchLayer` (one per-command identity stitcher) is provided by
  // the SAME reference to the platform-API factory and the linked-project cache so
  // memoisation gives both a single `stitchAttempted` guard — Go's one root-context
  // `sync.Once`.
  const platformApiFactory = legacyPlatformApiFactoryLayer.pipe(
    Layer.provide(credentials),
    Layer.provide(cliConfig),
    Layer.provide(legacyDebugLoggerLayer),
    Layer.provide(legacyIdentityStitchLayer),
  );

  const built = Layer.mergeAll(
    cliConfig,
    platformApiFactory,
    legacyProjectRefLayer.pipe(Layer.provide(platformApiFactory), Layer.provide(cliConfig)),
    legacyLinkedProjectCacheLayer.pipe(
      Layer.provide(credentials),
      Layer.provide(cliConfig),
      Layer.provide(httpClient),
      Layer.provide(legacyIdentityStitchLayer),
    ),
    legacyTelemetryStateLayer,
    // The one per-command identity stitcher (Go's single root-context `sync.Once`),
    // exposed at top level so `withLegacyCommandInstrumentation` can read
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
  | LegacyCliConfig
  | LegacyProjectRefResolver
  | LegacyLinkedProjectCache
  | LegacyTelemetryState
  | LegacyIdentityStitch
  | CommandRuntime;
