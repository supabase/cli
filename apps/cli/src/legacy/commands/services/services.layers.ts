import { FetchHttpClient } from "effect/unstable/http";
import { Layer } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";

import { legacyCredentialsLayer } from "../../auth/legacy-credentials.layer.ts";
import { LegacyCredentials } from "../../auth/legacy-credentials.service.ts";
import { legacyCliConfigLayer } from "../../config/legacy-cli-config.layer.ts";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { legacyDebugLoggerLayer } from "../../shared/legacy-debug-logger.layer.ts";
import { LegacyDebugLogger } from "../../shared/legacy-debug-logger.service.ts";
import { legacyHttpClientLayer } from "../../auth/legacy-http-debug.layer.ts";
import { legacyLinkedProjectCacheLayer } from "../../telemetry/legacy-linked-project-cache.layer.ts";
import { LegacyLinkedProjectCache } from "../../telemetry/legacy-linked-project-cache.service.ts";
import { legacyTelemetryStateLayer } from "../../telemetry/legacy-telemetry-state.layer.ts";
import { LegacyTelemetryState } from "../../telemetry/legacy-telemetry-state.service.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { CommandRuntime } from "../../../shared/runtime/command-runtime.service.ts";

/**
 * `services` always prints the local service matrix and only performs linked
 * version checks when both a linked project ref and an access token are present.
 * Keep this runtime lean so a tokenless local invocation does not fail before
 * the handler can choose the local-only path.
 */
export const legacyServicesRuntimeLayer = (() => {
  const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
  const httpClient = legacyHttpClientLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
  const credentials = legacyCredentialsLayer.pipe(
    Layer.provide(cliConfig),
    Layer.provide(legacyDebugLoggerLayer),
  );

  const built = Layer.mergeAll(
    httpClient,
    credentials,
    cliConfig,
    legacyDebugLoggerLayer,
    legacyLinkedProjectCacheLayer.pipe(
      Layer.provide(credentials),
      Layer.provide(cliConfig),
      Layer.provide(httpClient),
    ),
    legacyTelemetryStateLayer,
    commandRuntimeLayer(["services"]),
  ).pipe(Layer.provide(FetchHttpClient.layer));

  const _serviceCoverageCheck: Layer.Layer<LegacyServicesServices, unknown, unknown> = built;
  void _serviceCoverageCheck;

  return built;
})();

type LegacyServicesServices =
  | HttpClient.HttpClient
  | LegacyCredentials
  | LegacyCliConfig
  | LegacyDebugLogger
  | LegacyLinkedProjectCache
  | LegacyTelemetryState
  | CommandRuntime;
