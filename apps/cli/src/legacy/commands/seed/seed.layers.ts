import { Layer } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { legacyCredentialsLayer } from "../../auth/legacy-credentials.layer.ts";
import { legacyPlatformApiFactoryLayer } from "../../auth/legacy-platform-api-factory.layer.ts";
import { LegacyPlatformApiFactory } from "../../auth/legacy-platform-api-factory.service.ts";
import { legacyCliConfigLayer } from "../../config/legacy-cli-config.layer.ts";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { legacyProjectRefLayer } from "../../config/legacy-project-ref.layer.ts";
import { LegacyProjectRefResolver } from "../../config/legacy-project-ref.service.ts";
import { legacyDebugLoggerLayer } from "../../shared/legacy-debug-logger.layer.ts";
import {
  LegacyIdentityStitch,
  legacyIdentityStitchLayer,
} from "../../shared/legacy-identity-stitch.ts";
import { legacyHttpClientLayer } from "../../auth/legacy-http-debug.layer.ts";
import { legacyLinkedProjectCacheLayer } from "../../telemetry/legacy-linked-project-cache.layer.ts";
import { LegacyLinkedProjectCache } from "../../telemetry/legacy-linked-project-cache.service.ts";
import { legacyTelemetryStateLayer } from "../../telemetry/legacy-telemetry-state.layer.ts";
import { LegacyTelemetryState } from "../../telemetry/legacy-telemetry-state.service.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { CommandRuntime } from "../../../shared/runtime/command-runtime.service.ts";

/**
 * `seed buckets` uses the Storage gateway directly, so the Management API client
 * must be lazy: the LOCAL path (no `--linked`) never touches the Management API and
 * must not require a login. `legacyPlatformApiFactoryLayer` defers token resolution
 * to the first `factory.make` call, which only fires on the `--linked` branch.
 *
 * `HttpClient` is exposed at the top level (unlike `legacyGenTypesRuntimeLayer`)
 * because `buckets.handler.ts` uses the Storage gateway, which requires an `HttpClient`
 * service directly rather than going through the typed Management API client.
 */
export function legacySeedRuntimeLayer(subcommand: ReadonlyArray<string>) {
  const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
  const httpClient = legacyHttpClientLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
  const credentials = legacyCredentialsLayer.pipe(
    Layer.provide(cliConfig),
    Layer.provide(legacyDebugLoggerLayer),
  );
  // Lazy factory: build does NOT resolve a token. Token resolution is deferred
  // until `factory.make` is first called — i.e. when the `--linked` branch of
  // `legacyGetProjectApiKeys` actually executes. The LOCAL path (no `--linked`)
  // completes without touching the Management API. Mirrors
  // `legacyGenTypesRuntimeLayer` and `legacyLinkedDbResolverRuntimeLayer`.
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

  const _serviceCoverageCheck: Layer.Layer<LegacySeedServices, unknown, unknown> = built;
  void _serviceCoverageCheck;

  return built;
}

type LegacySeedServices =
  | LegacyPlatformApiFactory
  | LegacyCliConfig
  | LegacyProjectRefResolver
  | LegacyLinkedProjectCache
  | LegacyTelemetryState
  | LegacyIdentityStitch
  | CommandRuntime
  | HttpClient.HttpClient;
