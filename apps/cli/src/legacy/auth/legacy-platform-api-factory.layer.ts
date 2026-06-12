import { FetchHttpClient } from "effect/unstable/http";
import { Effect, FileSystem, Layer, Path } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";

import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { LegacyDebugLogger } from "../shared/legacy-debug-logger.service.ts";
import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import { TelemetryRuntime } from "../../shared/telemetry/runtime.service.ts";
import { LegacyCredentials } from "./legacy-credentials.service.ts";
import { legacyMakePlatformApi } from "./legacy-platform-api.layer.ts";
import { LegacyPlatformApiFactory } from "./legacy-platform-api-factory.service.ts";

/**
 * Ambient services `legacyMakePlatformApi` reads. The factory layer captures the
 * surrounding context once and re-provides it to each deferred `make`, so the
 * client is built with the same config / credentials / telemetry wiring the
 * eager `legacyPlatformApiLayer` would have used — just lazily.
 *
 * `HttpClient.HttpClient` is satisfied internally by `FetchHttpClient.layer`
 * (matching the eager Management-API stack, which also provides the raw fetch
 * client and lets `legacyMakePlatformApi`'s `transformClient` add the single
 * `--debug` request log). It is therefore NOT a requirement of this layer.
 */
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
 * Provides `LegacyPlatformApiFactory` without resolving an access token. Building
 * this layer only captures the ambient context; the token is resolved (and may
 * fail with `LegacyPlatformAuthRequiredError`) lazily inside `make`.
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
