import { Effect, FileSystem, Layer, Path } from "effect";

import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyDebugLogger } from "../../../shared/legacy-debug-logger.service.ts";
import { legacyPgDeltaLegacyEngineLayer } from "./legacy-pgdelta-engine.legacy.layer.ts";
import { legacyPgDeltaNextEngineLayer } from "./legacy-pgdelta-engine.next.layer.ts";
import { LegacyPgDeltaEngine } from "./legacy-pgdelta-engine.service.ts";
import { LegacyPgDeltaNextAdapter } from "./legacy-pgdelta-next-adapter.service.ts";
import { LegacyPgDeltaNextShadow } from "./legacy-pgdelta-next-shadow.service.ts";
import { LegacyDeclarativeSeam } from "./legacy-pgdelta.seam.service.ts";
import { LegacyEdgeRuntimeScript } from "../../../shared/legacy-edge-runtime-script.service.ts";
import { LegacyPgDeltaSslProbe } from "../../../shared/legacy-pgdelta-ssl-probe.service.ts";
import { legacyResolvePgDeltaImplementation } from "../../../shared/legacy-pgdelta-next-flag.ts";

const FLAG = "SUPABASE_USE_PG_DELTA_NEXT";

const resolveAndLog = Effect.fnUntraced(function* (raw: string | undefined) {
  const debug = yield* LegacyDebugLogger;
  const implementation = legacyResolvePgDeltaImplementation(raw);
  yield* debug.debug(`Using pg-delta ${implementation} implementation.`);
  return implementation;
});

/**
 * Selects exactly one implementation layer. There is intentionally no catch or
 * retry path between implementations: a selected next-engine failure must
 * propagate without invoking the legacy adapter.
 */
export function legacyPgDeltaEngineSelectorLayer(
  raw: string | undefined,
  layers: {
    readonly next: Layer.Layer<LegacyPgDeltaEngine>;
    readonly legacy: Layer.Layer<LegacyPgDeltaEngine>;
  },
) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const implementation = yield* resolveAndLog(raw);
      return implementation === "next" ? layers.next : layers.legacy;
    }),
  );
}

/** Reads the rollout flag once when the command-scoped layer is constructed. */
export const legacyPgDeltaEngineLayer = Layer.unwrap(
  Effect.gen(function* () {
    const raw = process.env[FLAG];
    const implementation = yield* resolveAndLog(raw);
    return selectProductionLayer(implementation);
  }),
);

function selectProductionLayer(
  implementation: "next" | "legacy",
): Layer.Layer<
  LegacyPgDeltaEngine,
  never,
  | LegacyPgDeltaNextAdapter
  | LegacyPgDeltaNextShadow
  | LegacyDebugLogger
  | LegacyDeclarativeSeam
  | LegacyEdgeRuntimeScript
  | LegacyPgDeltaSslProbe
  | FileSystem.FileSystem
  | Output
  | Path.Path
> {
  return implementation === "next" ? legacyPgDeltaNextEngineLayer : legacyPgDeltaLegacyEngineLayer;
}
