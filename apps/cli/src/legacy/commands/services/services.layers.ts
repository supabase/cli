import { Layer } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";

import { legacyCredentialsLayer } from "../../auth/legacy-credentials.layer.ts";
import { LegacyCredentials } from "../../auth/legacy-credentials.service.ts";
import { legacyCliConfigLayer } from "../../config/legacy-cli-config.layer.ts";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { legacyDebugLoggerLayer } from "../../shared/legacy-debug-logger.layer.ts";
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
 * It never builds the typed Management API client, so this runtime omits the
 * eager platform-API stack of `legacyManagementApiRuntimeLayer` to keep a
 * tokenless local invocation from failing before the handler runs (CLI-1619).
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
    legacyLinkedProjectCacheLayer.pipe(
      Layer.provide(credentials),
      Layer.provide(cliConfig),
      Layer.provide(httpClient),
    ),
    legacyTelemetryStateLayer,
    commandRuntimeLayer(["services"]),
  );

  const _serviceCoverageCheck: Layer.Layer<LegacyServicesServices, unknown, unknown> = built;
  void _serviceCoverageCheck;

  return built;
})();

type LegacyServicesServices =
  | HttpClient.HttpClient
  | LegacyCredentials
  | LegacyCliConfig
  | LegacyLinkedProjectCache
  | LegacyTelemetryState
  | CommandRuntime;
