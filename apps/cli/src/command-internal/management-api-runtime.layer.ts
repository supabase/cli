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
 * `commandSettingsLayer` must be piped to both the platform API stack and
 * `projectRefLayer`. `Layer.provide` satisfies a requirement on the target layer;
 * it does not expose the provided service to siblings of a `Layer.mergeAll(...)`. The
 * project-ref layer reads `CommandSettings` directly for workdir/projectId resolution,
 * so without an explicit provide here the bundled runtime panics with
 * `Service not found: supabase/legacy/CliSettings`. Handlers that yield `CommandSettings`
 * directly (e.g. `branches get`, `suggestUpgrade`) also need the service exposed
 * at the top level of the merged layer, hence the top-level `cliSettings` entry below.
 *
 * `httpClientLayer` and `CommandCredentials` are exposed at the top level so
 * handlers / helpers that bypass the typed Management API client can read them
 * directly:
 * - `sso add` / `sso update` POST/PUT raw JSON to preserve arbitrary
 * `attribute_mapping.keys.<x>.default` fields the typed input schema omits.
 * - `suggestUpgrade` GETs `/v1/projects/{ref}` and `/v1/organizations/{slug}/entitlements`
 * directly because the typed `V1GetProjectOutput` decode rejects the
 * `__PROJECT_REF__` placeholder cli-e2e replay fixtures embed in response bodies
 * (`ref: isMinLength(20)` fails on the 15-char placeholder).
 *
 * Layers are memoised by reference, so the merge + provide combos reuse the same
 * instance instead of building two debug-logging wrappers / two keyring readers.
 *
 * @param subcommand - command path segments after `supabase`, e.g. `["backups", "list"]`.
 */
export function managementApiRuntimeLayer(subcommand: ReadonlyArray<string>) {
  // Memoise the shared layers so the platform API, top-level service surface,
  // project resolver, and linked-project cache all reuse the same config /
  // credentials / HTTP instances.
  const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));
  const httpClient = httpClientLayer.pipe(Layer.provide(debugLoggerLayer));
  const credentials = commandCredentialsLayer.pipe(
    Layer.provide(cliSettings),
    Layer.provide(debugLoggerLayer),
  );
  // `commandPlatformApiLayer` applies typed API debug logging after generated
  // requests have been prefixed with the active profile's API URL.
  // `identityStitchLayer` is the one per-command identity stitcher; the
  // SAME reference is provided to the cache below so (by layer memoisation) the
  // typed client and the cache GET share a single `stitchAttempted` guard — Go's
  // one root-context `sync.Once`, not one per transport.
  // `dohFetchLayer` overrides `FetchHttpClient.Fetch` with a
  // DNS-over-HTTPS-aware fetch when `--dns-resolver https` is set — mirrors
  // `withFallbackDNS` hook.
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
    // Expose the single per-command identity stitcher at the top level so the
    // post-run instrumentation can read stitchedDistinctId() via serviceOption.
    // The same reference is provided into platformApiStack and the cache, so by
    // layer memoisation all three share one stitchAttempted guard — Go's one
    // root-context sync.Once.
    identityStitchLayer,
    // Expose the same memoised instance already provided into cliSettings/httpClient/etc.
    // at the top level so handlers can log a swallowed, non-fatal error directly
    // (`fmt.Fprintln(utils.GetDebugLogger(), err)` pattern, e.g. `secrets set`).
    debugLoggerLayer,
  );

  // Compile-time guarantee that the merged layer exposes every service a
  // Management-API legacy handler is allowed to yield from its top-level
  // `Effect.fn` body. If a future handler yields a service NOT in this union,
  // either:
  // (a) the new service belongs in the runtime layer — add it to the merge
  // above AND to `ManagementApiServices` below, or
  // (b) the service comes from the surrounding root layer (`Output`,
  // `OutputFlag`, `Analytics`, `Stdio`, `Tty`, …) and is therefore
  // already provided via `runCli` / `cliProgramFor` — no change here.
  //
  // The assertion uses `unknown` for E and R so that the assertion ONLY fires
  // for missing exposed services; changes to the layer's internal error /
  // requirement channels do not perturb this check. cli-e2e parity tests
  // surface missing-service runtime panics, but the same class of bug is now
  // caught at compile time.
  const _serviceCoverageCheck: Layer.Layer<ManagementApiServices, unknown, unknown> = built;
  void _serviceCoverageCheck;

  return built;
}

/**
 * Services that every Management-API legacy handler is allowed to yield
 * directly from its top-level `Effect.fn` body. Adding a new `yield* X` in a
 * handler without adding `X` here is a **compile error**, surfacing what was
 * previously a runtime `Service not found: …` panic that only the cli-e2e
 * parity suite caught.
 *
 * `Output`, `OutputFlag`, `Analytics`, `Stdio`, `Tty`, `ProcessControl`,
 * and `RuntimeInfo` are intentionally NOT listed — they're root-level services
 * provided by `runCli` / the shared `cliProgramFor`, not by this command-level
 * runtime layer.
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
 * `db schema declarative generate/sync`). Identical to `managementApiRuntimeLayer`
 * except it exposes the access token **lazily** via `CommandPlatformApiFactory`
 * (`commandPlatformApiFactoryLayer`) instead of the eager `CommandPlatformApi` stack.
 *
 * Building this layer resolves NO access token — `commandPlatformApiFactoryLayer`
 * captures context and wraps `makeCommandPlatformApi` in `Effect.cached`, deferring
 * token resolution to the first `factory.make` (i.e. when `initLoginRole` /
 * `listAndUnban` actually call the Management API). This never loads a token when a
 * DB password
 * is supplied — so `db dump --linked --password …` / `… generate --linked --password`
 * succeed without a login. Management API commands that legitimately require a token
 * keep using `managementApiRuntimeLayer`, where the eager stack fails up front.
 */
export function linkedDbResolverRuntimeLayer(subcommand: ReadonlyArray<string>) {
  const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));
  const httpClient = httpClientLayer.pipe(Layer.provide(debugLoggerLayer));
  const credentials = commandCredentialsLayer.pipe(
    Layer.provide(cliSettings),
    Layer.provide(debugLoggerLayer),
  );
  // Lazy factory: its build does NOT resolve a token (see doc above). The factory
  // shares the same underlying deps as the eager platform API stack, so the
  // ambient requirements match `managementApiRuntimeLayer` exactly.
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
