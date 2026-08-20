import { Context, type Effect, type Scope } from "effect";

import type { LegacyDeclarativeShadowDbError } from "./legacy-pgdelta.errors.ts";
import type { LegacyDbTomlValues } from "../../../shared/legacy-db-config.toml-read.ts";
import type { LegacyPgDeltaContext } from "../../../shared/legacy-pgdelta.ts";

/** The live migrated database needed by pg-delta next database diffs. */
export interface LegacyPgDeltaNextMigrationsShadow {
  /** Platform baseline with the project's local migrations applied. */
  readonly migrationsUrl: string;
}

/** Platform baseline with no project migrations and no declaration-prep drops. */
export interface LegacyPgDeltaNextPlatformShadow {
  readonly platformUrl: string;
}

/** The two live databases needed to plan declarative SQL with pg-delta next. */
export interface LegacyPgDeltaNextPlanShadows extends LegacyPgDeltaNextMigrationsShadow {
  /** Independent platform baseline owned by `planSchemaFiles` while loading desired SQL. */
  readonly declarativeUrl: string;
  /** Both databases are separate servers restored from CLI-owned PGDATA snapshots. */
  readonly allowSameDatabaseIdentity: boolean;
}

export interface LegacyPgDeltaNextShadowInput {
  readonly context: LegacyPgDeltaContext;
  readonly toml: LegacyDbTomlValues;
  readonly projectRef?: string;
  /**
   * `db schema declarative sync --no-cache` (and generate's same flag): force a fresh
   * shadow baseline instead of restoring/publishing the global snapshot cache.
   */
  readonly bypassCache?: boolean;
}

interface LegacyPgDeltaNextShadowShape {
  /**
   * Provisions only the migrated next-engine shadow needed by database diffs.
   * The container is removed when the current Effect scope closes.
   */
  readonly provisionMigrations: (
    opts: LegacyPgDeltaNextShadowInput,
  ) => Effect.Effect<
    LegacyPgDeltaNextMigrationsShadow,
    LegacyDeclarativeShadowDbError,
    Scope.Scope
  >;
  /**
   * Platform baseline only: no project migrations, no pgjwt/pgcrypto/uuid-ossp
   * drop. Shares the migrations cache key (`webhooks: config`). Removed when
   * the current Effect scope closes.
   */
  readonly provisionPlatform: (
    opts: LegacyPgDeltaNextShadowInput,
  ) => Effect.Effect<LegacyPgDeltaNextPlatformShadow, LegacyDeclarativeShadowDbError, Scope.Scope>;
  /**
   * Provisions only the declarative next-engine shadow (stripped platform
   * baseline, no project migrations). Removed when the current Effect scope closes.
   */
  readonly provisionDeclarative: (
    opts: LegacyPgDeltaNextShadowInput,
  ) => Effect.Effect<
    { readonly declarativeUrl: string },
    LegacyDeclarativeShadowDbError,
    Scope.Scope
  >;
  /**
   * Provisions the independent migrated and declarative shadows needed by a
   * declarative plan. Concurrency is strategy-driven (see
   * `legacy-pgdelta-next-shadow.plan.ts`): warm snapshots restore in parallel,
   * a shared cold baseline is built once and handed off, and everything else
   * runs sequentially — with the concurrent shapes buffering the declarative
   * side's output so progress lines never interleave. Both shadows are removed
   * when the current Effect scope closes.
   */
  readonly provisionPlan: (
    opts: LegacyPgDeltaNextShadowInput,
  ) => Effect.Effect<LegacyPgDeltaNextPlanShadows, LegacyDeclarativeShadowDbError, Scope.Scope>;
}

export class LegacyPgDeltaNextShadow extends Context.Service<
  LegacyPgDeltaNextShadow,
  LegacyPgDeltaNextShadowShape
>()("supabase/legacy/PgDeltaNextShadow") {}
