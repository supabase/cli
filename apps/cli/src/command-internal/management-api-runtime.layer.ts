import { Layer } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { FetchHttpClient } from "effect/unstable/http";

import { CommandCredentials } from "../auth/command-credentials.service.ts";
import { commandCredentialsLayer } from "../auth/command-credentials.layer.ts";
import { httpClientLayer } from "../auth/http-debug.layer.ts";
import {
  commandPlatformApiFactoryFromApiLayer,
  commandPlatformApiFactoryLayer,
} from "../auth/command-platform-api-factory.layer.ts";
import { CommandPlatformApi } from "../auth/command-platform-api.service.ts";
import { commandPlatformApiLayer } from "../auth/command-platform-api.layer.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { commandSettingsLayer } from "../config/command-settings.layer.ts";
import { ProjectRefResolver } from "../config/project-ref.service.ts";
import { projectRefLayer } from "../config/project-ref.layer.ts";
import { DebugLogger } from "./debug-logger.service.ts";
import { debugLoggerLayer } from "./debug-logger.layer.ts";
import { dohFetchLayer } from "./http-dns.ts";
import { IdentityStitch, identityStitchLayer } from "./identity-stitch.ts";
import { LinkedProjectCache } from "../telemetry/linked-project-cache.service.ts";
import { linkedProjectCacheLayer } from "../telemetry/linked-project-cache.layer.ts";
import { TelemetryState } from "../telemetry/telemetry-state.service.ts";
import { telemetryStateLayer } from "../telemetry/telemetry-state.layer.ts";
import { CommandRuntime } from "../shared/runtime/command-runtime.service.ts";
import { commandRuntimeLayer } from "../shared/runtime/command-runtime.layer.ts";

/**
 * Composes the runtime layer for a Management-API-style `supabase <command> <subcommand>`
 * invocation.
 *
 * `commandSettingsLayer`, `httpClientLayer`, and `CommandCredentials` are exposed at the top
 * level, not just piped into the platform API stack, because `Layer.provide` doesn't share a
 * service to siblings inside `Layer.mergeAll` (see the CLI Invariants in apps/cli/CLAUDE.md) —
 * several handlers yield these services directly or bypass the typed Management API client.
 *
 * Layers are memoised by reference, so shared instances aren't rebuilt per merge/provide site.
 *
 * @param subcommand - command path segments after `supabase`, e.g. `["backups", "list"]`.
 */
export function managementApiRuntimeLayer(subcommand: ReadonlyArray<string>) {
  const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));
  const httpClient = httpClientLayer.pipe(Layer.provide(debugLoggerLayer));
  const credentials = commandCredentialsLayer.pipe(
    Layer.provide(cliSettings),
    Layer.provide(debugLoggerLayer),
  );
  // `identityStitchLayer` is the one per-command identity stitcher; the same reference is
  // provided to the cache below so, by layer memoisation, the typed client and the cache share a
  // single `stitchAttempted` guard instead of one per transport.
  // `dohFetchLayer` overrides `FetchHttpClient.Fetch` with a DNS-over-HTTPS-aware fetch when
  // `--dns-resolver https` is set.
  const platformApiStack = commandPlatformApiLayer.pipe(
    Layer.provide(credentials),
    Layer.provide(cliSettings),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(dohFetchLayer),
    Layer.provide(debugLoggerLayer),
    Layer.provide(identityStitchLayer),
  );
  const platformApiFactory = commandPlatformApiFactoryFromApiLayer.pipe(
    Layer.provide(platformApiStack),
  );
  const built = Layer.mergeAll(
    platformApiStack,
    platformApiFactory,
    httpClient,
    credentials,
    cliSettings,
    projectRefLayer.pipe(Layer.provide(platformApiFactory), Layer.provide(cliSettings)),
    linkedProjectCacheLayer.pipe(
      Layer.provide(credentials),
      Layer.provide(cliSettings),
      Layer.provide(httpClient),
      Layer.provide(identityStitchLayer),
    ),
    telemetryStateLayer,
    commandRuntimeLayer([...subcommand]),
    // Exposed at the top level so post-run instrumentation can read `stitchedDistinctId()` via
    // `serviceOption`.
    identityStitchLayer,
    // Exposed at the top level so handlers can log a swallowed, non-fatal error directly
    // (e.g. `secrets set`).
    debugLoggerLayer,
  );

  // Compile-time guarantee that the merged layer exposes every service a Management-API handler
  // may yield from its top-level `Effect.fn` body — a service missing from `ManagementApiServices`
  // below becomes a type error here instead of a `Service not found` runtime panic. `unknown` for
  // E and R keeps this check scoped to exposed services only.
  const _serviceCoverageCheck: Layer.Layer<ManagementApiServices, unknown, unknown> = built;
  void _serviceCoverageCheck;

  return built;
}

/**
 * Services every Management-API handler may yield directly from its top-level `Effect.fn` body.
 * Adding a new `yield* X` without adding `X` here is a compile error instead of a runtime
 * `Service not found: …` panic.
 *
 * `Output`, `OutputFlag`, `Analytics`, `Stdio`, `Tty`, `ProcessControl`, and `RuntimeInfo` are
 * intentionally not listed — they're root-level services provided by `runCli`/`cliProgramFor`,
 * not by this command-level runtime layer.
 */
type ManagementApiServices =
  | CommandPlatformApi
  | HttpClient.HttpClient
  | CommandCredentials
  | CommandSettings
  | ProjectRefResolver
  | LinkedProjectCache
  | TelemetryState
  | CommandRuntime
  | IdentityStitch
  | DebugLogger;

/**
 * Runtime layer for the `--linked` db-config resolver path (`db dump`, `db query`,
 * `db schema declarative generate/sync`). Identical to `managementApiRuntimeLayer`, except the
 * access token resolves lazily via `CommandPlatformApiFactory` on first use instead of eagerly, so
 * `--linked --password …` invocations succeed without requiring a login.
 */
export function linkedDbResolverRuntimeLayer(subcommand: ReadonlyArray<string>) {
  const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));
  const httpClient = httpClientLayer.pipe(Layer.provide(debugLoggerLayer));
  const credentials = commandCredentialsLayer.pipe(
    Layer.provide(cliSettings),
    Layer.provide(debugLoggerLayer),
  );
  const platformApiFactory = commandPlatformApiFactoryLayer.pipe(
    Layer.provide(credentials),
    Layer.provide(cliSettings),
    Layer.provide(debugLoggerLayer),
  );
  const built = Layer.mergeAll(
    platformApiFactory,
    httpClient,
    credentials,
    cliSettings,
    projectRefLayer.pipe(Layer.provide(platformApiFactory), Layer.provide(cliSettings)),
    linkedProjectCacheLayer.pipe(
      Layer.provide(credentials),
      Layer.provide(cliSettings),
      Layer.provide(httpClient),
    ),
    telemetryStateLayer,
    commandRuntimeLayer([...subcommand]),
  );
  return built;
}

type LinkedDbResolverRuntime = ReturnType<typeof linkedDbResolverRuntimeLayer>;
export type LinkedDbResolverRuntimeRequirements =
  LinkedDbResolverRuntime extends Layer.Layer<infer _A, infer _E, infer R> ? R : never;
