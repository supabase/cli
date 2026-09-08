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
import {
  LegacyIdentityStitch,
  legacyIdentityStitchLayer,
} from "../../command-internal/legacy-identity-stitch.ts";
import { legacyManagementApiRuntimeLayer } from "../../command-internal/legacy-management-api-runtime.layer.ts";
import { MachineErrorContext } from "../../shared/output/machine-error-context.service.ts";
import { machineErrorContextLayer } from "../../shared/output/machine-error-context.layer.ts";
import { CommandRuntime } from "../../shared/runtime/command-runtime.service.ts";
import { Stdin } from "../../shared/runtime/stdin.service.ts";
import { stdinLayer } from "../../shared/runtime/stdin.layer.ts";
import { LegacyLinkedProjectCache } from "../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../telemetry/legacy-telemetry-state.service.ts";
import {
  legacyMigraRuntimeLayer,
  legacyPgDeltaCommandRuntimeLayer,
  legacyPgDeltaDbConfigRuntimeLayer,
} from "../db/shared/legacy-pgdelta-engine.layer.ts";

/**
 * Runtime layer for `supabase pull`. Composes only the db-specific pieces of
 * `db pull`'s own runtime (`legacyPgDeltaDbConfigRuntimeLayer` /
 * `legacyPgDeltaCommandRuntimeLayer` / `legacyMigraRuntimeLayer` —
 * `LegacyDbConfigResolver`/`LegacyDbConnection`, the pg-delta/migra diff
 * engines, shadow DB / Docker spawning — plus the bare identity-stitch and
 * stdin layers) with the eager Management API stack `config pull`/`functions
 * download` use (`legacyManagementApiRuntimeLayer`), plus `MachineErrorContext`
 * for the single-envelope machine-mode failure path (`status`'s own
 * precedent). `legacyMigrationDbRuntimeLayer` (`migration fetch`'s own
 * runtime) is documented as a strict subset of this db-schema-pull stack — no
 * separate migration layer is merged in.
 *
 * Deliberately NOT merged in: `db/pull/pull.layers.ts`'s
 * `legacyDbSchemaPullRuntimeLayer` wrapper itself, specifically its
 * `legacyLinkedDbResolverRuntimeLayer(command)` piece
 * (`command-internal/legacy-management-api-runtime.layer.ts:174-204`). That
 * piece independently binds the same four services
 * `legacyManagementApiRuntimeLayer` already provides —
 * `LegacyProjectRefResolver`, `LegacyLinkedProjectCache`, `LegacyCliSettings`,
 * `CommandRuntime` — backed by the LAZY `LegacyPlatformApiFactory` stack
 * instead of the eager one `legacyManagementApiRuntimeLayer` uses.
 *
 * An earlier version of this file merged both wrappers and relied on
 * `Layer.mergeAll` argument order to make the eager binding win, citing
 * `Context.mergeAll`'s "last wins" duplicate-key rule
 * (`.repos/effect/packages/effect/src/Context.ts:1112-1113`). That reasoning
 * doesn't apply here: both wrappers' resolver/cache layers are ultimately the
 * SAME module-level singletons (`legacyProjectRefLayer`,
 * `legacyLinkedProjectCacheLayer` — `config/legacy-project-ref.layer.ts:29`),
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
 * bypassing `legacyLinkedDbResolverRuntimeLayer` entirely — removes the
 * second binding, so `legacyManagementApiRuntimeLayer`'s eager-backed
 * resolver/cache is the SOLE provider of all four services and there is no
 * race left to reason about.
 */
export const legacyPullRuntimeLayer = Layer.mergeAll(
  legacyPgDeltaDbConfigRuntimeLayer,
  legacyPgDeltaCommandRuntimeLayer,
  legacyMigraRuntimeLayer,
  legacyIdentityStitchLayer,
  stdinLayer,
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
