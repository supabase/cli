import { FetchHttpClient } from "effect/unstable/http";
import { Effect, FileSystem, Layer, Path } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { legacyCredentialsLayer } from "../../../auth/legacy-credentials.layer.ts";
import { LegacyCredentials } from "../../../auth/legacy-credentials.service.ts";
import { legacyMakePlatformApi } from "../../../auth/legacy-platform-api.layer.ts";
import { LegacyPlatformApiFactory } from "../../../auth/legacy-platform-api.service.ts";
import { legacyCliConfigLayer } from "../../../config/legacy-cli-config.layer.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { legacyProjectRefLayer } from "../../../config/legacy-project-ref.layer.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { LegacyDebugLogger } from "../../../shared/legacy-debug-logger.service.ts";
import { legacyHttpClientLayer } from "../../../auth/legacy-http-debug.layer.ts";
import { legacyLinkedProjectCacheLayer } from "../../../telemetry/legacy-linked-project-cache.layer.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { CommandRuntime } from "../../../../shared/runtime/command-runtime.service.ts";
import { Analytics } from "../../../../shared/telemetry/analytics.service.ts";
import { TelemetryRuntime } from "../../../../shared/telemetry/runtime.service.ts";

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
  const platformApiFactory = Layer.effect(
    LegacyPlatformApiFactory,
    Effect.gen(function* () {
      const analytics = yield* Analytics;
      const cliConfigService = yield* LegacyCliConfig;
      const credentialsService = yield* LegacyCredentials;
      const debugLogger = yield* LegacyDebugLogger;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const telemetryRuntime = yield* TelemetryRuntime;

      return LegacyPlatformApiFactory.of({
        make: legacyMakePlatformApi.pipe(
          Effect.provideService(Analytics, analytics),
          Effect.provideService(LegacyCliConfig, cliConfigService),
          Effect.provideService(LegacyCredentials, credentialsService),
          Effect.provideService(LegacyDebugLogger, debugLogger),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(TelemetryRuntime, telemetryRuntime),
          Effect.provide(FetchHttpClient.layer),
        ),
      });
    }),
  );
  const platformApiFactoryStack = platformApiFactory.pipe(
    Layer.provide(credentials),
    Layer.provide(cliConfig),
    Layer.provide(legacyDebugLoggerLayer),
  );

  const built = Layer.mergeAll(
    httpClient,
    credentials,
    cliConfig,
    legacyDebugLoggerLayer,
    platformApiFactoryStack,
    legacyProjectRefLayer.pipe(Layer.provide(platformApiFactoryStack), Layer.provide(cliConfig)),
    legacyLinkedProjectCacheLayer.pipe(
      Layer.provide(credentials),
      Layer.provide(cliConfig),
      Layer.provide(httpClient),
    ),
    legacyTelemetryStateLayer,
    commandRuntimeLayer(["gen", "types"]),
  ).pipe(Layer.provide(FetchHttpClient.layer));

  const _serviceCoverageCheck: Layer.Layer<LegacyGenTypesServices, unknown, unknown> = built;
  void _serviceCoverageCheck;

  return built;
})();

type LegacyGenTypesServices =
  | HttpClient.HttpClient
  | LegacyCredentials
  | LegacyCliConfig
  | LegacyDebugLogger
  | LegacyPlatformApiFactory
  | LegacyProjectRefResolver
  | LegacyLinkedProjectCache
  | LegacyTelemetryState
  | CommandRuntime;
