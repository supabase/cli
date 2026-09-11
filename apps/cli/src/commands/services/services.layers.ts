import { FetchHttpClient } from "effect/unstable/http";
import { Layer } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";

import { commandCredentialsLayer } from "../../auth/command-credentials.layer.ts";
import { CommandCredentials } from "../../auth/command-credentials.service.ts";
import { commandSettingsLayer } from "../../config/command-settings.layer.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { debugLoggerLayer } from "../../command-internal/debug-logger.layer.ts";
import { DebugLogger } from "../../command-internal/debug-logger.service.ts";
import { IdentityStitch, identityStitchLayer } from "../../command-internal/identity-stitch.ts";
import { httpClientLayer } from "../../auth/http-debug.layer.ts";
import { linkedProjectCacheLayer } from "../../telemetry/linked-project-cache.layer.ts";
import { LinkedProjectCache } from "../../telemetry/linked-project-cache.service.ts";
import { telemetryStateLayer } from "../../telemetry/telemetry-state.layer.ts";
import { TelemetryState } from "../../telemetry/telemetry-state.service.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { CommandRuntime } from "../../shared/runtime/command-runtime.service.ts";

/**
 * `services` always prints the local service matrix and only performs linked
 * version checks when both a linked project ref and an access token are
 * present. Keep this runtime lean so a tokenless local invocation succeeds.
 */
export const servicesRuntimeLayer = (() => {
  const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));
  const httpClient = httpClientLayer.pipe(Layer.provide(debugLoggerLayer));
  const credentials = commandCredentialsLayer.pipe(
    Layer.provide(cliSettings),
    Layer.provide(debugLoggerLayer),
  );

  const built = Layer.mergeAll(
    httpClient,
    credentials,
    cliSettings,
    debugLoggerLayer,
    linkedProjectCacheLayer.pipe(
      Layer.provide(credentials),
      Layer.provide(cliSettings),
      Layer.provide(httpClient),
      // The cache GET stitches session identity via the one per-command
      // `IdentityStitch` (only ever run once per command).
      Layer.provide(identityStitchLayer),
    ),
    telemetryStateLayer,
    // Exposed at top level so `withCommandTelemetry` can attribute
    // cli_command_executed to the gotrue id via `stitchedDistinctId()`. The
    // same instance is shared with linkedProjectCache so both stitch at most once.
    identityStitchLayer,
    commandRuntimeLayer(["services"]),
  ).pipe(Layer.provide(FetchHttpClient.layer));

  const _serviceCoverageCheck: Layer.Layer<ServicesServices, unknown, unknown> = built;
  void _serviceCoverageCheck;

  return built;
})();

type ServicesServices =
  | HttpClient.HttpClient
  | CommandCredentials
  | CommandSettings
  | DebugLogger
  | LinkedProjectCache
  | TelemetryState
  | IdentityStitch
  | CommandRuntime;
