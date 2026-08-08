import { Effect, Layer } from "effect";

import {
  LegacyPgDeltaNextShadow,
  type LegacyPgDeltaNextMigrationsShadow,
  type LegacyPgDeltaNextPlanShadows,
} from "./legacy-pgdelta-next-shadow.service.ts";
import { LegacyDeclarativeSeam } from "./legacy-pgdelta.seam.service.ts";

/**
 * Scoped next-engine shadow orchestration over the narrow Go `db __shadow`
 * seam. Go creates independent migrated and declarative clusters; declarative
 * SQL remains wholly owned by the TypeScript pg-delta next adapter.
 */
export const legacyPgDeltaNextShadowLayer = Layer.effect(
  LegacyPgDeltaNextShadow,
  Effect.gen(function* () {
    const seam = yield* LegacyDeclarativeSeam;

    return LegacyPgDeltaNextShadow.of({
      provisionMigrations: ({ schema, projectRef }) =>
        Effect.gen(function* () {
          return (yield* seam.provisionNextMigrationsShadow({
            schema,
            ...(projectRef !== undefined ? { projectRef } : {}),
          })) satisfies LegacyPgDeltaNextMigrationsShadow;
        }),
      provisionPlan: ({ schema, projectRef }) =>
        Effect.gen(function* () {
          return (yield* seam.provisionNextPlanShadows({
            schema,
            ...(projectRef !== undefined ? { projectRef } : {}),
          })) satisfies LegacyPgDeltaNextPlanShadows;
        }),
    });
  }),
);
