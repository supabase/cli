import { Layer } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";

import { legacyHttpClientLayer } from "../../auth/legacy-http-debug.layer.ts";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { legacyCliConfigLayer } from "../../config/legacy-cli-config.layer.ts";
import { legacyDebugLoggerLayer } from "../../shared/legacy-debug-logger.layer.ts";
import { LegacyTelemetryState } from "../../telemetry/legacy-telemetry-state.service.ts";
import { legacyTelemetryStateLayer } from "../../telemetry/legacy-telemetry-state.layer.ts";
import { CommandRuntime } from "../../../shared/runtime/command-runtime.service.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";

/**
 * Runtime layer for `supabase seed <subcommand>`.
 *
 * `seed buckets` is a **local-only** command: Go's `seed` command defines no
 * `--project-ref` flag, so `flags.ParseProjectRef` (gated on that flag,
 * `cmd/root.go:112`) never runs and `flags.ProjectRef` is always empty. The
 * remote client factory, service-role-key resolution, and analytics-bucket
 * upsert are therefore unreachable and intentionally absent — this layer
 * deliberately omits the credentials / platform-API / project-ref / linked-cache
 * stack that `legacyManagementApiRuntimeLayer` carries.
 *
 * It exposes only:
 *   - `HttpClient` (via `legacyHttpClientLayer`, with `--debug` request logging)
 *     for the Storage service-gateway calls,
 *   - `LegacyCliConfig` for `--workdir` resolution (config-file base path),
 *   - `LegacyTelemetryState` for the telemetry flush (`PersistentPostRun` parity),
 *   - `CommandRuntime` for command-scoped instrumentation.
 *
 * `Output`, `Tty`, `RuntimeInfo`, and `FileSystem`/`Path` (`BunServices`) come
 * from the root `runCli` wiring.
 */
export function legacySeedRuntimeLayer(subcommand: ReadonlyArray<string>) {
  const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
  const httpClient = legacyHttpClientLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

  const built = Layer.mergeAll(
    httpClient,
    cliConfig,
    legacyTelemetryStateLayer,
    commandRuntimeLayer([...subcommand]),
  );

  // Compile-time guarantee that the merged layer exposes exactly the services a
  // seed handler is allowed to yield from its top-level `Effect.fn` body. The
  // assertion uses `unknown` for E and R so it fires only for missing exposed
  // services, mirroring `legacy-management-api-runtime.layer.ts`.
  const _serviceCoverageCheck: Layer.Layer<LegacySeedServices, unknown, unknown> = built;
  void _serviceCoverageCheck;

  return built;
}

type LegacySeedServices =
  | HttpClient.HttpClient
  | LegacyCliConfig
  | LegacyTelemetryState
  | CommandRuntime;
