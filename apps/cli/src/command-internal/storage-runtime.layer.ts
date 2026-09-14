import { Layer } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { commandCredentialsLayer } from "../auth/command-credentials.layer.ts";
import { commandPlatformApiFactoryLayer } from "../auth/command-platform-api-factory.layer.ts";
import { CommandPlatformApiFactory } from "../auth/command-platform-api-factory.service.ts";
import { commandSettingsLayer } from "../config/command-settings.layer.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { projectRefLayer } from "../config/project-ref.layer.ts";
import { ProjectRefResolver } from "../config/project-ref.service.ts";
import { debugLoggerLayer } from "./debug-logger.layer.ts";
import { IdentityStitch, identityStitchLayer } from "./identity-stitch.ts";
import { httpClientLayer } from "../auth/http-debug.layer.ts";
import { linkedProjectCacheLayer } from "../telemetry/linked-project-cache.layer.ts";
import { LinkedProjectCache } from "../telemetry/linked-project-cache.service.ts";
import { telemetryStateLayer } from "../telemetry/telemetry-state.layer.ts";
import { TelemetryState } from "../telemetry/telemetry-state.service.ts";
import { commandRuntimeLayer } from "../shared/runtime/command-runtime.layer.ts";
import { CommandRuntime } from "../shared/runtime/command-runtime.service.ts";

/**
 * Runtime layer for the commands that talk to the Storage gateway directly:
 * `seed buckets` and `storage ls/cp/mv/rm`. The Management API client is lazy,
 * so the local path (no `--linked`) never resolves a token or requires login.
 *
 * `HttpClient` is exposed at the top level because the Storage gateway needs
 * it directly, not through the typed Management API client.
 */
export function storageGatewayRuntimeLayer(subcommand: ReadonlyArray<string>) {
  const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));
  const httpClient = httpClientLayer.pipe(Layer.provide(debugLoggerLayer));
  const credentials = commandCredentialsLayer.pipe(
    Layer.provide(cliSettings),
    Layer.provide(debugLoggerLayer),
  );
  // Token resolution is deferred until `factory.make` is first called, on the
  // `--linked` branch.
  const platformApiFactory = commandPlatformApiFactoryLayer.pipe(
    Layer.provide(credentials),
    Layer.provide(cliSettings),
    Layer.provide(debugLoggerLayer),
    Layer.provide(identityStitchLayer),
  );

  const built = Layer.mergeAll(
    cliSettings,
    platformApiFactory,
    httpClient,
    projectRefLayer.pipe(Layer.provide(platformApiFactory), Layer.provide(cliSettings)),
    linkedProjectCacheLayer.pipe(
      Layer.provide(credentials),
      Layer.provide(cliSettings),
      Layer.provide(httpClient),
      Layer.provide(identityStitchLayer),
    ),
    telemetryStateLayer,
    identityStitchLayer,
    commandRuntimeLayer([...subcommand]),
  );

  const _serviceCoverageCheck: Layer.Layer<StorageGatewayServices, unknown, unknown> = built;
  void _serviceCoverageCheck;

  return built;
}

type StorageGatewayServices =
  | CommandPlatformApiFactory
  | CommandSettings
  | ProjectRefResolver
  | LinkedProjectCache
  | TelemetryState
  | IdentityStitch
  | CommandRuntime
  | HttpClient.HttpClient;
