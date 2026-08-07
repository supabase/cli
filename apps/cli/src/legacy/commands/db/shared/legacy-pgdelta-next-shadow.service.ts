import { Context, type Effect, type Scope } from "effect";

import type { LegacyDeclarativeShadowDbError } from "./legacy-pgdelta.errors.ts";

/** The two live databases needed to plan with the bundled pg-delta next engine. */
export interface LegacyPgDeltaNextShadowDatabases {
  /** Platform baseline with the project's local migrations applied. */
  readonly migrationsUrl: string;
  /** Independent platform baseline owned by `planSchemaFiles` while loading desired SQL. */
  readonly declarativeUrl: string;
}

interface LegacyPgDeltaNextShadowShape {
  /**
   * Provisions both next-engine shadow containers and owns them for the current
   * Effect scope. Both containers are removed when that scope closes.
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
