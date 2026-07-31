import { Layer } from "effect";

import { legacyCredentialsLayer } from "../../../auth/legacy-credentials.layer.ts";
import { legacyHttpClientLayer } from "../../../auth/legacy-http-debug.layer.ts";
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
import { legacyLinkedProjectCacheLayer } from "../../../telemetry/legacy-linked-project-cache.layer.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { CommandRuntime } from "../../../../shared/runtime/command-runtime.service.ts";
import * as HttpClient from "effect/unstable/http/HttpClient";

/**
 * Unlike `gen types`, `--local` still needs the HTTP client directly (a plain
 * `GET /rest/v1/` against the local stack's API gateway), so `httpClient` is
 * exposed at the top level rather than only threaded into
 * `legacyLinkedProjectCacheLayer`.
 */
export const legacyGenTanstackDbRuntimeLayer = (() => {
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

  const built = Layer.mergeAll(
    cliConfig,
    httpClient,
    platformApiFactory,
    legacyProjectRefLayer.pipe(Layer.provide(platformApiFactory), Layer.provide(cliConfig)),
    legacyLinkedProjectCacheLayer.pipe(
      Layer.provide(credentials),
      Layer.provide(cliConfig),
      Layer.provide(httpClient),
      Layer.provide(legacyIdentityStitchLayer),
    ),
    legacyTelemetryStateLayer,
    legacyIdentityStitchLayer,
    commandRuntimeLayer(["gen", "tanstack-db"]),
  );

  const _serviceCoverageCheck: Layer.Layer<LegacyGenTanstackDbServices, unknown, unknown> = built;
  void _serviceCoverageCheck;

  return built;
})();

type LegacyGenTanstackDbServices =
  | LegacyPlatformApiFactory
  | LegacyCliConfig
  | LegacyProjectRefResolver
  | LegacyLinkedProjectCache
  | LegacyTelemetryState
  | LegacyIdentityStitch
  | CommandRuntime
  | HttpClient.HttpClient;
