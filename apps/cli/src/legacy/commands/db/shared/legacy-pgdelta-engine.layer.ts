import { Config, Effect, FileSystem, Layer, Option, Path } from "effect";

import { legacyHttpClientLayer } from "../../../auth/legacy-http-debug.layer.ts";
import { legacyCliConfigLayer } from "../../../config/legacy-cli-config.layer.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { legacyDbConfigLayer } from "../../../shared/legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "../../../shared/legacy-db-connection.layer.ts";
import { legacyLoadProjectEnv } from "../../../shared/legacy-db-config.toml-read.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { LegacyDebugLogger } from "../../../shared/legacy-debug-logger.service.ts";
import { legacyDockerRunLayer } from "../../../shared/legacy-docker-run.layer.ts";
import { legacyEdgeRuntimeScriptLayer } from "../../../shared/legacy-edge-runtime-script.layer.ts";
import { legacyIdentityStitchLayer } from "../../../shared/legacy-identity-stitch.ts";
import { legacyPgDeltaSslProbeLayer } from "../../../shared/legacy-pgdelta-ssl-probe.layer.ts";
import {
  LEGACY_PG_DELTA_NEXT_FLAG_NAME,
  legacyPgDeltaImplementationFlag,
  legacyResolvePgDeltaImplementation,
} from "../../../shared/legacy-pgdelta-next-flag.ts";
import { legacyPgDeltaLegacyEngineLayer } from "./legacy-pgdelta-engine.legacy.layer.ts";
import { legacyPgDeltaNextEngineLayer } from "./legacy-pgdelta-engine.next.layer.ts";
import { LegacyPgDeltaEngine } from "./legacy-pgdelta-engine.service.ts";
import { legacyPgDeltaNextAdapterLayer } from "./legacy-pgdelta-next-adapter.layer.ts";
import { legacyPgDeltaNextShadowLayer } from "./legacy-pgdelta-next-shadow.layer.ts";
import { legacyDeclarativeSeamLayer } from "./legacy-pgdelta.seam.layer.ts";

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
export function legacyPgDeltaEngineSelectorLayer<RNext, RLegacy>(
  raw: string | undefined,
  layers: {
    readonly next: Layer.Layer<LegacyPgDeltaEngine, never, RNext>;
    readonly legacy: Layer.Layer<LegacyPgDeltaEngine, never, RLegacy>;
  },
): Layer.Layer<LegacyPgDeltaEngine, never, RNext | RLegacy | LegacyDebugLogger> {
  return Layer.unwrap(
    Effect.gen(function* () {
      const implementation = yield* resolveAndLog(raw);
      const selected: Layer.Layer<LegacyPgDeltaEngine, never, RNext | RLegacy> =
        implementation === "next" ? layers.next : layers.legacy;
      return selected;
    }),
  );
}

/** Resolves the rollout flag once when the command-scoped layer is constructed. */
export const legacyPgDeltaEngineLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cliConfig = yield* LegacyCliConfig;
    const projectEnv = yield* legacyLoadProjectEnv(fs, path, cliConfig.workdir);
    const shellFlag = yield* Config.option(Config.string(LEGACY_PG_DELTA_NEXT_FLAG_NAME));
    const raw = legacyPgDeltaImplementationFlag(
      Option.getOrUndefined(shellFlag),
      projectEnv[LEGACY_PG_DELTA_NEXT_FLAG_NAME],
    );
    return legacyPgDeltaEngineSelectorLayer(raw, {
      next: legacyPgDeltaNextEngineLayer,
      legacy: legacyPgDeltaLegacyEngineLayer,
    });
  }),
);

export const legacyPgDeltaCliConfigRuntimeLayer = legacyCliConfigLayer.pipe(
  Layer.provide(legacyDebugLoggerLayer),
);

export const legacyPgDeltaDbConfigRuntimeLayer = legacyDbConfigLayer.pipe(
  Layer.provide(legacyPgDeltaCliConfigRuntimeLayer),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(legacyDebugLoggerLayer),
  Layer.provide(legacyIdentityStitchLayer),
);

const edgeRuntime = legacyEdgeRuntimeScriptLayer.pipe(
  Layer.provide(legacyDockerRunLayer),
  Layer.provide(legacyPgDeltaCliConfigRuntimeLayer),
);
const httpClient = legacyHttpClientLayer.pipe(Layer.provide(legacyDebugLoggerLayer));
const seam = legacyDeclarativeSeamLayer.pipe(
  Layer.provide(legacyPgDeltaCliConfigRuntimeLayer),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(legacyDockerRunLayer),
  Layer.provide(edgeRuntime),
  Layer.provide(legacyPgDeltaSslProbeLayer),
  Layer.provide(httpClient),
);
const nextShadow = legacyPgDeltaNextShadowLayer.pipe(
  Layer.provide(legacyDockerRunLayer),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(httpClient),
);
const engine = legacyPgDeltaEngineLayer.pipe(
  Layer.provide(legacyPgDeltaCliConfigRuntimeLayer),
  Layer.provide(legacyPgDeltaNextAdapterLayer),
  Layer.provide(nextShadow),
  Layer.provide(edgeRuntime),
  Layer.provide(legacyPgDeltaSslProbeLayer),
  Layer.provide(seam),
  Layer.provide(legacyDockerRunLayer),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(httpClient),
  Layer.provide(legacyDebugLoggerLayer),
);

export const legacyPgDeltaCommandRuntimeLayer = Layer.mergeAll(
  legacyDbConnectionLayer,
  legacyDockerRunLayer,
  edgeRuntime,
  legacyPgDeltaSslProbeLayer,
  httpClient,
  seam,
  engine,
  legacyPgDeltaCliConfigRuntimeLayer,
);
