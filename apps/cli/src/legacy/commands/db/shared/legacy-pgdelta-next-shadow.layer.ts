import { Effect, Layer } from "effect";

import { LegacyDeclarativeShadowDbError } from "./legacy-pgdelta.errors.ts";
import {
  LegacyPgDeltaNextShadow,
  type LegacyPgDeltaNextShadowDatabases,
} from "./legacy-pgdelta-next-shadow.service.ts";
import { LegacyDeclarativeSeam } from "./legacy-pgdelta.seam.service.ts";

/**
 * Scoped next-engine shadow orchestration over the narrow Go `db __shadow`
 * seam. Go creates the migrated target and a dedicated empty same-cluster
 * scratch database; declarative SQL remains wholly owned by the TypeScript
 * pg-delta next adapter and its `planSchemaFiles` operation.
 */
export const legacyPgDeltaNextShadowLayer = Layer.effect(
  LegacyPgDeltaNextShadow,
  Effect.gen(function* () {
    const seam = yield* LegacyDeclarativeSeam;

    return LegacyPgDeltaNextShadow.of({
      provision: ({ schema, projectRef }) =>
        Effect.gen(function* () {
          // Register cleanup immediately after Go returns the container. URL
          // validation happens only after acquireRelease has installed the
          // finalizer, so even malformed seam output cannot leak the shadow.
          const shadow = yield* Effect.acquireRelease(
            seam.provisionShadow({
              mode: "pgdelta-next",
              targetLocal: false,
              usePgDelta: false,
              schema,
              ...(projectRef !== undefined ? { projectRef } : {}),
            }),
            ({ container }) => seam.removeShadowContainer(container).pipe(Effect.ignoreCause),
          );

          if (shadow.targetUrlOverride === undefined) {
            return yield* Effect.fail(
              new LegacyDeclarativeShadowDbError({
                message:
                  "failed to provision the pg-delta next shadow database: missing declarative scratch URL.",
              }),
            );
          }

          return {
            migrationsUrl: shadow.sourceUrl,
            scratchUrl: shadow.targetUrlOverride,
          } satisfies LegacyPgDeltaNextShadowDatabases;
        }),
    });
  }),
);
