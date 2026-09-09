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
 * Runtime layer for `supabase pull`. Composes only the db-specific pieces of
 * `db pull`'s own runtime (`pgDeltaDbConfigRuntimeLayer` /
 * `pgDeltaCommandRuntimeLayer` / `migraRuntimeLayer` —
 * `DbConfigResolver`/`DbConnection`, the pg-delta/migra diff
 * engines, shadow DB / Docker spawning — plus the bare identity-stitch and
 * stdin layers) with the eager Management API stack `config pull`/`functions
 * download` use (`managementApiRuntimeLayer`), plus `MachineErrorContext`
 * for the single-envelope machine-mode failure path (`status`'s own
 * precedent). `migrationDbRuntimeLayer` (`migration fetch`'s own
 * runtime) is documented as a strict subset of this db-schema-pull stack — no
 * separate migration layer is merged in.
 *
 * Deliberately NOT merged in: `db/pull/pull.layers.ts`'s
 * `dbSchemaPullRuntimeLayer` wrapper itself, specifically its
 * `linkedDbResolverRuntimeLayer(command)` piece
 * (`command-internal/management-api-runtime.layer.ts:174-204`). That
 * piece independently binds the same four services
 * `managementApiRuntimeLayer` already provides —
 * `ProjectRefResolver`, `LinkedProjectCache`, `CommandSettings`,
 * `CommandRuntime` — backed by the LAZY `CommandPlatformApiFactory` stack
 * instead of the eager one `managementApiRuntimeLayer` uses.
 *
 * An earlier version of this file merged both wrappers and relied on
 * `Layer.mergeAll` argument order to make the eager binding win, citing
 * `Context.mergeAll`'s "last wins" duplicate-key rule
 * (`.repos/effect/packages/effect/src/Context.ts:1112-1113`). That reasoning
 * doesn't apply here: both wrappers' resolver/cache layers are ultimately the
 * SAME module-level singletons (`projectRefLayer`,
 * `linkedProjectCacheLayer` — `config/project-ref.layer.ts:29`),
 * and `Layer.effect` builds via `fromBuildMemo`, which memoizes a layer by ITS
 * OWN object identity in a shared `MemoMap`
 * (`.repos/effect/packages/effect/src/Layer.ts:371-379`). `Layer.mergeAll`
 * builds every top-level layer CONCURRENTLY
 * (`Effect.forEach(layers, ..., { concurrency: layers.length })` —
 * `.repos/effect/packages/effect/src/Layer.ts:1143-1147`), so the singleton is
 * built exactly once and whichever of the two `.pipe(Layer.provide(...))`
 * wrappers happens to reach its `.build(...)` call first decides which
 * factory backs it — a build-order race, not a property of merge position or
 * `Context.mergeAll`. Merging in only the db-specific pieces below —
 * bypassing `linkedDbResolverRuntimeLayer` entirely — removes the
 * second binding, so `managementApiRuntimeLayer`'s eager-backed
 * resolver/cache is the SOLE provider of all four services and there is no
 * race left to reason about.
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
 * Compile-time guarantee that `pullRuntimeLayer` exposes the services
 * `pull.handler.ts`/`pull.steps.ts` need — mirrors
 * `management-api-runtime.layer.ts`'s own `_serviceCoverageCheck`
 * (`managementApiRuntimeLayer`, this file's neighbor). `Layer`'s
 * provided-services parameter is declared contravariant
 * (`interface Layer<in ROut, out E, out RIn>`), so this assignment only
 * type-checks when every service listed here is one `pullRuntimeLayer`
 * genuinely provides; a service dropped from the merge above without being
 * dropped here fails to compile. Root-level services (`Output`, `CliArgs`,
 * `Tty`, …) are deliberately excluded, same as the management-API precedent
 * — they come from `runCli`, not this command-level layer.
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
