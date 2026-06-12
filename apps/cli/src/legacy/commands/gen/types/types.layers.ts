import { Layer } from "effect";

import { legacyCredentialsLayer } from "../../../auth/legacy-credentials.layer.ts";
import { legacyPlatformApiFactoryLayer } from "../../../auth/legacy-platform-api-factory.layer.ts";
import { LegacyPlatformApiFactory } from "../../../auth/legacy-platform-api-factory.service.ts";
import { legacyCliConfigLayer } from "../../../config/legacy-cli-config.layer.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { legacyProjectRefLayer } from "../../../config/legacy-project-ref.layer.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
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
  const platformApiFactory = legacyPlatformApiFactoryLayer.pipe(
    Layer.provide(credentials),
    Layer.provide(cliConfig),
    Layer.provide(legacyDebugLoggerLayer),
  );

  const built = Layer.mergeAll(
    cliConfig,
    platformApiFactory,
    legacyProjectRefLayer.pipe(Layer.provide(platformApiFactory), Layer.provide(cliConfig)),
    legacyLinkedProjectCacheLayer.pipe(
      Layer.provide(credentials),
      Layer.provide(cliConfig),
      Layer.provide(httpClient),
    ),
    legacyTelemetryStateLayer,
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
  | CommandRuntime;
