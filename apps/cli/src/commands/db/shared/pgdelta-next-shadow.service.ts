import { Context, type Effect, type Scope } from "effect";

import type { DeclarativeShadowDbError } from "./pgdelta.errors.ts";
import type { DbTomlValues } from "../../../command-internal/db-config.toml-read.ts";
import type { PgDeltaContext } from "../../../command-internal/pgdelta.ts";

/** The live migrated database needed by pg-delta next database diffs. */
export interface PgDeltaNextMigrationsShadow {
  /** Platform baseline with the project's local migrations applied. */
  readonly migrationsUrl: string;
}

/** The two live databases needed to plan declarative SQL with pg-delta next. */
export interface PgDeltaNextPlanShadows extends PgDeltaNextMigrationsShadow {
  /** Independent platform baseline owned by `planSchemaFiles` while loading desired SQL. */
  readonly declarativeUrl: string;
  /** Both databases are separate servers restored from CLI-owned PGDATA snapshots. */
  readonly allowSameDatabaseIdentity: boolean;
}

export interface PgDeltaNextShadowInput {
  readonly context: PgDeltaContext;
  readonly toml: DbTomlValues;
  readonly projectRef?: string;
  /**
   * `db schema declarative sync --no-cache` (and generate's same flag): force a fresh
   * shadow baseline instead of restoring/publishing the global snapshot cache.
   */
  readonly bypassCache?: boolean;
}

interface PgDeltaNextShadowShape {
  /**
   * Provisions only the migrated next-engine shadow needed by database diffs.
   * The container is removed when the current Effect scope closes.
   */
  readonly provisionMigrations: (
    opts: PgDeltaNextShadowInput,
  ) => Effect.Effect<PgDeltaNextMigrationsShadow, DeclarativeShadowDbError, Scope.Scope>;
  /**
   * Provisions the independent migrated and declarative shadows needed by a declarative plan.
   * Concurrency is strategy-driven (see `pgdelta-next-shadow.plan.ts`). Both shadows are
   * removed when the current Effect scope closes.
   */
  readonly provisionPlan: (
    opts: PgDeltaNextShadowInput,
  ) => Effect.Effect<PgDeltaNextPlanShadows, DeclarativeShadowDbError, Scope.Scope>;
}

export class PgDeltaNextShadow extends Context.Service<PgDeltaNextShadow, PgDeltaNextShadowShape>()(
  "supabase/cli/PgDeltaNextShadow",
) {}
