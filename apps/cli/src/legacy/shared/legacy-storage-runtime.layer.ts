import { Layer } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { legacyCredentialsLayer } from "../auth/legacy-credentials.layer.ts";
import { legacyPlatformApiFactoryLayer } from "../auth/legacy-platform-api-factory.layer.ts";
import { LegacyPlatformApiFactory } from "../auth/legacy-platform-api-factory.service.ts";
import { legacyCliConfigLayer } from "../config/legacy-cli-config.layer.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { legacyProjectRefLayer } from "../config/legacy-project-ref.layer.ts";
import { LegacyProjectRefResolver } from "../config/legacy-project-ref.service.ts";
import { legacyDebugLoggerLayer } from "./legacy-debug-logger.layer.ts";
import { LegacyIdentityStitch, legacyIdentityStitchLayer } from "./legacy-identity-stitch.ts";
import { legacyHttpClientLayer } from "../auth/legacy-http-debug.layer.ts";
import { legacyLinkedProjectCacheLayer } from "../telemetry/legacy-linked-project-cache.layer.ts";
import { LegacyLinkedProjectCache } from "../telemetry/legacy-linked-project-cache.service.ts";
import { legacyTelemetryStateLayer } from "../telemetry/legacy-telemetry-state.layer.ts";
import { LegacyTelemetryState } from "../telemetry/legacy-telemetry-state.service.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { CommandRuntime } from "../../shared/runtime/command-runtime.service.ts";

/**
 * Runtime layer for the commands that talk to the Storage gateway directly:
 * `seed buckets` and `storage ls/cp/mv/rm`. The Management API client is **lazy**
 * so the LOCAL path (no `--linked`) never resolves a token / requires a login:
 * `legacyPlatformApiFactoryLayer` defers token resolution to the first
 * `factory.make` call, which only fires on the `--linked` branch (the remote
 * service-role-key fetch).
 *
 * `HttpClient` is exposed at the top level because the Storage gateway requires
 * an `HttpClient` service directly rather than going through the typed
 * Management API client.
 */
export function legacyStorageGatewayRuntimeLayer(subcommand: ReadonlyArray<string>) {
  const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
  const httpClient = legacyHttpClientLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
  const credentials = legacyCredentialsLayer.pipe(
    Layer.provide(cliConfig),
    Layer.provide(legacyDebugLoggerLayer),
  );
  // Lazy factory: build does NOT resolve a token. Token resolution is deferred
  // until `factory.make` is first called — i.e. when the `--linked` branch
  // actually executes. The LOCAL path completes without touching the Management
  // API.
  const platformApiFactory = legacyPlatformApiFactoryLayer.pipe(
    Layer.provide(credentials),
    Layer.provide(cliConfig),
    Layer.provide(legacyDebugLoggerLayer),
    Layer.provide(legacyIdentityStitchLayer),
  );

  const built = Layer.mergeAll(
    cliConfig,
    platformApiFactory,
    httpClient,
    legacyProjectRefLayer.pipe(Layer.provide(platformApiFactory), Layer.provide(cliConfig)),
    legacyLinkedProjectCacheLayer.pipe(
      Layer.provide(credentials),
      Layer.provide(cliConfig),
      Layer.provide(httpClient),
      Layer.provide(legacyIdentityStitchLayer),
    ),
    legacyTelemetryStateLayer,
    legacyIdentityStitchLayer,
    commandRuntimeLayer([...subcommand]),
  );

  const _serviceCoverageCheck: Layer.Layer<LegacyStorageGatewayServices, unknown, unknown> = built;
  void _serviceCoverageCheck;

  return built;
}

type LegacyStorageGatewayServices =
  | LegacyPlatformApiFactory
  | LegacyCliConfig
  | LegacyProjectRefResolver
  | LegacyLinkedProjectCache
  | LegacyTelemetryState
  | LegacyIdentityStitch
  | CommandRuntime
  | HttpClient.HttpClient;
