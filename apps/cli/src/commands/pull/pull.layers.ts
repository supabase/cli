import { Layer } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";

import { LegacyCredentials } from "../../auth/legacy-credentials.service.ts";
import { LegacyPlatformApi } from "../../auth/legacy-platform-api.service.ts";
import { LegacyCliSettings } from "../../config/legacy-cli-settings.service.ts";
import { LegacyProjectRefResolver } from "../../config/legacy-project-ref.service.ts";
import { LegacyDbConfigResolver } from "../../command-internal/legacy-db-config.service.ts";
import { LegacyDbConnection } from "../../command-internal/legacy-db-connection.service.ts";
import { LegacyDebugLogger } from "../../command-internal/legacy-debug-logger.service.ts";
import { LegacyDockerRun } from "../../command-internal/legacy-docker-run.service.ts";
import { LegacyIdentityStitch } from "../../command-internal/legacy-identity-stitch.ts";
import { legacyManagementApiRuntimeLayer } from "../../command-internal/legacy-management-api-runtime.layer.ts";
import { MachineErrorContext } from "../../shared/output/machine-error-context.service.ts";
import { machineErrorContextLayer } from "../../shared/output/machine-error-context.layer.ts";
import { CommandRuntime } from "../../shared/runtime/command-runtime.service.ts";
import { Stdin } from "../../shared/runtime/stdin.service.ts";
import { LegacyLinkedProjectCache } from "../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../telemetry/legacy-telemetry-state.service.ts";
import { legacyDbSchemaPullRuntimeLayer } from "../db/pull/pull.layers.ts";

/**
 * Runtime layer for `supabase pull`. Composes the same db-schema-pull stack
 * `db pull` provides for itself (`legacyDbSchemaPullRuntimeLayer` —
 * `LegacyDbConfigResolver`/`LegacyDbConnection`, the pg-delta/migra diff
 * engines, shadow DB / Docker spawning, the lazy linked-resolver auth stack)
 * with the eager Management API stack `config pull`/`functions download`
 * use (`legacyManagementApiRuntimeLayer`), plus `MachineErrorContext` for the
 * single-envelope machine-mode failure path (`status`'s own precedent).
 * `legacyMigrationDbRuntimeLayer` (`migration fetch`'s own runtime) is
 * documented as a strict subset of this db-schema-pull stack — no separate
 * migration layer is merged in.
 *
 * `Layer.mergeAll`'s duplicate-tag resolution keeps the LAST layer's binding
 * (`Context.mergeAll`: "the service from the last context with that key is
 * kept" — `.repos/effect/packages/effect/src/Context.ts:1113`), so
 * `legacyManagementApiRuntimeLayer` is placed AFTER the db-schema-pull layer
 * on purpose: both layers bind `LegacyProjectRefResolver`, and only the
 * management-API layer's binding is backed by the EAGER `LegacyPlatformApi`
 * stack (its `LegacyPlatformApiFactory` wraps an already-resolved client —
 * `legacy-management-api-runtime.layer.ts`'s own doc comment). The
 * db-schema-pull layer's own resolver is backed by the LAZY factory
 * (`legacyLinkedDbResolverRuntimeLayer`), which would resolve a second,
 * independent token if its resolver ever reached the interactive
 * project-picker path — the property this orchestrator's single
 * `legacyResolveConfigTarget` call depends on not happening. The same
 * ordering also lets the management API layer's (functionally equivalent)
 * `LegacyCliSettings`/`CommandRuntime` bindings win; `LegacyTelemetryState`
 * is the same memoised `legacyTelemetryStateLayer` reference in both
 * layers, so it is only ever built once regardless of merge order.
 */
export const legacyPullRuntimeLayer = Layer.mergeAll(
  legacyDbSchemaPullRuntimeLayer(["pull"]),
  legacyManagementApiRuntimeLayer(["pull"]),
  machineErrorContextLayer,
);

/**
 * Compile-time guarantee that `legacyPullRuntimeLayer` exposes the services
 * `pull.handler.ts`/`pull.steps.ts` need — mirrors
 * `legacy-management-api-runtime.layer.ts`'s own `_serviceCoverageCheck`
 * (`legacyManagementApiRuntimeLayer`, this file's neighbor). `Layer`'s
 * provided-services parameter is declared contravariant
 * (`interface Layer<in ROut, out E, out RIn>`), so this assignment only
 * type-checks when every service listed here is one `legacyPullRuntimeLayer`
 * genuinely provides; a service dropped from the merge above without being
 * dropped here fails to compile. Root-level services (`Output`, `CliArgs`,
 * `Tty`, …) are deliberately excluded, same as the management-API precedent
 * — they come from `runCli`, not this command-level layer.
 */
type LegacyPullServices =
  | LegacyPlatformApi
  | HttpClient.HttpClient
  | LegacyCredentials
  | LegacyCliSettings
  | LegacyProjectRefResolver
  | LegacyLinkedProjectCache
  | LegacyTelemetryState
  | CommandRuntime
  | LegacyIdentityStitch
  | LegacyDebugLogger
  | LegacyDbConfigResolver
  | LegacyDbConnection
  | LegacyDockerRun
  | Stdin
  | MachineErrorContext;

const _serviceCoverageCheck: Layer.Layer<LegacyPullServices, unknown, unknown> =
  legacyPullRuntimeLayer;
void _serviceCoverageCheck;
