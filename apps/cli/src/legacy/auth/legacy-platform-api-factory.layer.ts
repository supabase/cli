import { FetchHttpClient } from "effect/unstable/http";
import { Effect, FileSystem, Layer, Path } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";

import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import { TelemetryRuntime } from "../../shared/telemetry/runtime.service.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { LegacyDebugLogger } from "../shared/legacy-debug-logger.service.ts";
import { LegacyCredentials } from "./legacy-credentials.service.ts";
import { legacyMakePlatformApi } from "./legacy-platform-api.layer.ts";
import { LegacyPlatformApi } from "./legacy-platform-api.service.ts";
import { LegacyPlatformApiFactory } from "./legacy-platform-api-factory.service.ts";

type LegacyPlatformApiDeps =
  | Analytics
  | LegacyCliConfig
  | LegacyCredentials
  | LegacyDebugLogger
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | TelemetryRuntime;

/**
 * Captures the surrounding Management API context without resolving an access
 * token. The raw fetch client is provided here so `legacyMakePlatformApi` owns
 * the single typed-API debug wrapper.
 */
export const legacyPlatformApiFactoryLayer = Layer.effect(
  LegacyPlatformApiFactory,
  Effect.gen(function* () {
    const context = yield* Effect.context<LegacyPlatformApiDeps>();
    return LegacyPlatformApiFactory.of({
      make: legacyMakePlatformApi.pipe(Effect.provideContext(context)),
    });
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

/**
 * Adapts an already-built eager `LegacyPlatformApi` into a factory. Use this in
 * runtimes that intentionally require Management API auth up front but still
 * need to satisfy services that consume the lazy factory shape.
 */
export const legacyPlatformApiFactoryFromApiLayer = Layer.effect(
  LegacyPlatformApiFactory,
  LegacyPlatformApi.pipe(
    Effect.map((api) =>
      LegacyPlatformApiFactory.of({
        make: Effect.succeed(api),
      }),
    ),
  ),
);
