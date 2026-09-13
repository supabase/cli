import { Layer } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";

import { CommandCredentials } from "../../auth/command-credentials.service.ts";
import { CommandPlatformApi } from "../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../config/project-ref.service.ts";
import { DbConfigResolver } from "../../command-internal/db-config.service.ts";
import { DbConnection } from "../../command-internal/db-connection.service.ts";
import { DebugLogger } from "../../command-internal/debug-logger.service.ts";
import { DockerRun } from "../../command-internal/docker-run.service.ts";
import { IdentityStitch, identityStitchLayer } from "../../command-internal/identity-stitch.ts";
import { managementApiRuntimeLayer } from "../../command-internal/management-api-runtime.layer.ts";
import { MachineErrorContext } from "../../shared/output/machine-error-context.service.ts";
import { machineErrorContextLayer } from "../../shared/output/machine-error-context.layer.ts";
import { CommandRuntime } from "../../shared/runtime/command-runtime.service.ts";
import { Stdin } from "../../shared/runtime/stdin.service.ts";
import { stdinLayer } from "../../shared/runtime/stdin.layer.ts";
import { LinkedProjectCache } from "../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../telemetry/telemetry-state.service.ts";
import {
  migraRuntimeLayer,
  pgDeltaCommandRuntimeLayer,
  pgDeltaDbConfigRuntimeLayer,
} from "../../command-internal/pgdelta-engine-runtime.layer.ts";

/**
 * Runtime layer for `supabase pull`: composes `db pull`'s db-specific pieces with the eager
 * Management API stack and `MachineErrorContext` for single-envelope machine failures. Excludes
 * `dbSchemaPullRuntimeLayer`'s `linkedDbResolverRuntimeLayer` piece, which independently binds
 * the same services via a different (lazy) factory — merging both would race over which
 * factory wins, since concurrent layer builds settle a shared singleton in build order.
 */
export const pullRuntimeLayer = Layer.mergeAll(
  pgDeltaDbConfigRuntimeLayer,
  pgDeltaCommandRuntimeLayer,
  migraRuntimeLayer,
  identityStitchLayer,
  stdinLayer,
  managementApiRuntimeLayer(["pull"]),
  machineErrorContextLayer,
);

/**
 * Compile-time check that `pullRuntimeLayer` provides every service `pull.handler.ts`/
 * `pull.steps.ts` need; a service dropped from the merge above without being dropped here fails
 * to compile. Root-level services (`Output`, `CliArgs`, `Tty`, …) are excluded since they come
 * from `runCli`, not this command-level layer.
 */
type PullServices =
  | CommandPlatformApi
  | HttpClient.HttpClient
  | CommandCredentials
  | CommandSettings
  | ProjectRefResolver
  | LinkedProjectCache
  | TelemetryState
  | CommandRuntime
  | IdentityStitch
  | DebugLogger
  | DbConfigResolver
  | DbConnection
  | DockerRun
  | Stdin
  | MachineErrorContext;

const _serviceCoverageCheck: Layer.Layer<PullServices, unknown, unknown> = pullRuntimeLayer;
void _serviceCoverageCheck;
