import { Layer } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { FetchHttpClient } from "effect/unstable/http";

import { LegacyCredentials } from "../auth/legacy-credentials.service.ts";
import { legacyCredentialsLayer } from "../auth/legacy-credentials.layer.ts";
import { legacyHttpClientLayer } from "../auth/legacy-http-debug.layer.ts";
import { LegacyPlatformApi } from "../auth/legacy-platform-api.service.ts";
import { legacyPlatformApiLayer } from "../auth/legacy-platform-api.layer.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { legacyCliConfigLayer } from "../config/legacy-cli-config.layer.ts";
import { LegacyProjectRefResolver } from "../config/legacy-project-ref.service.ts";
import { legacyProjectRefLayer } from "../config/legacy-project-ref.layer.ts";
import { legacyDebugLoggerLayer } from "./legacy-debug-logger.layer.ts";
import { LegacyLinkedProjectCache } from "../telemetry/legacy-linked-project-cache.service.ts";
import { legacyLinkedProjectCacheLayer } from "../telemetry/legacy-linked-project-cache.layer.ts";
import { LegacyTelemetryState } from "../telemetry/legacy-telemetry-state.service.ts";
import { legacyTelemetryStateLayer } from "../telemetry/legacy-telemetry-state.layer.ts";
import { CommandRuntime } from "../../shared/runtime/command-runtime.service.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";

/**
 * Composes the runtime layer for a Management-API-style `supabase <command> <subcommand>`
 * invocation.
 *
 * `legacyCliConfigLayer` must be piped to both the platform API stack and
 * `legacyProjectRefLayer`. `Layer.provide` satisfies a requirement on the target layer;
 * it does not expose the provided service to siblings of a `Layer.mergeAll(...)`. The
 * project-ref layer reads `LegacyCliConfig` directly for workdir/projectId resolution,
 * so without an explicit provide here the bundled runtime panics with
 * `Service not found: supabase/legacy/CliConfig`. Handlers that yield `LegacyCliConfig`
 * directly (e.g. `branches get`, `legacySuggestUpgrade`) also need the service exposed
 * at the top level of the merged layer, hence the top-level `cliConfig` entry below.
 *
 * `legacyHttpClientLayer` and `LegacyCredentials` are exposed at the top level so
 * handlers / helpers that bypass the typed Management API client can read them
 * directly:
 *   - `sso add` / `sso update` POST/PUT raw JSON to preserve arbitrary
 *     `attribute_mapping.keys.<x>.default` fields the typed input schema omits.
 *   - `legacySuggestUpgrade` GETs `/v1/projects/{ref}` and `/v1/organizations/{slug}/entitlements`
 *     directly because the typed `V1GetProjectOutput` decode rejects the
 *     `__PROJECT_REF__` placeholder cli-e2e replay fixtures embed in response bodies
 *     (`ref: isMinLength(20)` fails on the 15-char placeholder).
 *
 * Layers are memoised by reference, so the merge + provide combos reuse the same
 * instance instead of building two debug-logging wrappers / two keyring readers.
 *
 * @param subcommand - command path segments after `supabase`, e.g. `["backups", "list"]`.
 */
export function legacyManagementApiRuntimeLayer(subcommand: ReadonlyArray<string>) {
  // Memoise the shared layers so the platform API, top-level service surface,
  // project resolver, and linked-project cache all reuse the same config /
  // credentials / HTTP instances.
  const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
  const httpClient = legacyHttpClientLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
  const credentials = legacyCredentialsLayer.pipe(
    Layer.provide(cliConfig),
    Layer.provide(legacyDebugLoggerLayer),
  );
  // `legacyPlatformApiLayer` applies typed API debug logging after generated
  // requests have been prefixed with the active profile's API URL.
  const platformApiStack = legacyPlatformApiLayer.pipe(
    Layer.provide(credentials),
    Layer.provide(cliConfig),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(legacyDebugLoggerLayer),
  );
  const built = Layer.mergeAll(
    platformApiStack,
    httpClient,
    credentials,
    cliConfig,
    legacyProjectRefLayer.pipe(Layer.provide(platformApiStack), Layer.provide(cliConfig)),
    legacyLinkedProjectCacheLayer.pipe(
      Layer.provide(credentials),
      Layer.provide(cliConfig),
      Layer.provide(httpClient),
    ),
    legacyTelemetryStateLayer,
    commandRuntimeLayer([...subcommand]),
  );

  // Compile-time guarantee that the merged layer exposes every service a
  // Management-API legacy handler is allowed to yield from its top-level
  // `Effect.fn` body. If a future handler yields a service NOT in this union,
  // either:
  //   (a) the new service belongs in the runtime layer — add it to the merge
  //       above AND to `LegacyManagementApiServices` below, or
  //   (b) the service comes from the surrounding root layer (`Output`,
  //       `LegacyOutputFlag`, `Analytics`, `Stdio`, `Tty`, …) and is therefore
  //       already provided via `runCli` / `cliProgramFor` — no change here.
  //
  // The assertion uses `unknown` for E and R so that the assertion ONLY fires
  // for missing exposed services; changes to the layer's internal error /
  // requirement channels do not perturb this check. cli-e2e parity tests
  // surface missing-service runtime panics, but the same class of bug is now
  // caught at compile time.
  const _serviceCoverageCheck: Layer.Layer<LegacyManagementApiServices, unknown, unknown> = built;
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
 * `Output`, `LegacyOutputFlag`, `Analytics`, `Stdio`, `Tty`, `ProcessControl`,
 * and `RuntimeInfo` are intentionally NOT listed — they're root-level services
 * provided by `runCli` / the shared `cliProgramFor`, not by this command-level
 * runtime layer.
 */
type LegacyManagementApiServices =
  | LegacyPlatformApi
  | HttpClient.HttpClient
  | LegacyCredentials
  | LegacyCliConfig
  | LegacyProjectRefResolver
  | LegacyLinkedProjectCache
  | LegacyTelemetryState
  | CommandRuntime;

/**
 * The ambient services this runtime layer itself requires (global flags, root
 * services, etc.) and the error it can fail with at build (access-token
 * resolution). Exported as named types so consumers that provide this layer
 * lazily (e.g. `legacy-db-config.layer.ts`'s `--linked` branch) can express
 * their own requirement/error channels without re-deriving the structural
 * inference at each call site.
 */
type LegacyManagementApiRuntime = ReturnType<typeof legacyManagementApiRuntimeLayer>;
export type LegacyManagementApiRuntimeRequirements =
  LegacyManagementApiRuntime extends Layer.Layer<infer _A, infer _E, infer R> ? R : never;
export type LegacyManagementApiRuntimeError =
  LegacyManagementApiRuntime extends Layer.Layer<infer _A, infer E, infer _R> ? E : never;
