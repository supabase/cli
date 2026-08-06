import { Context, type Effect, type Scope } from "effect";

import type { LegacyDeclarativeShadowDbError } from "./legacy-pgdelta.errors.ts";

/** The two live databases needed to plan with the bundled pg-delta next engine. */
export interface LegacyPgDeltaNextShadowDatabases {
  /** Platform baseline with the project's local migrations applied. */
  readonly migrationsUrl: string;
  /** Empty same-cluster database owned by `planSchemaFiles` while loading desired SQL. */
  readonly scratchUrl: string;
}

interface LegacyPgDeltaNextShadowShape {
  /**
   * Provisions the next-engine shadow container and owns it for the current
   * Effect scope. The container is removed when that scope closes, including
   * when URL validation or the caller fails.
   */
  readonly provision: (opts: {
    readonly schema: ReadonlyArray<string>;
    readonly projectRef?: string;
  }) => Effect.Effect<
    LegacyPgDeltaNextShadowDatabases,
    LegacyDeclarativeShadowDbError,
    Scope.Scope
  >;
}

export class LegacyPgDeltaNextShadow extends Context.Service<
  LegacyPgDeltaNextShadow,
  LegacyPgDeltaNextShadowShape
>()("supabase/legacy/PgDeltaNextShadow") {}
