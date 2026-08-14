import { Effect, FileSystem, Layer, Path } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type { GlobalFlag } from "effect/unstable/cli";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { legacyHttpClientLayer } from "../../../auth/legacy-http-debug.layer.ts";
import { legacyCliConfigLayer } from "../../../config/legacy-cli-config.layer.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { legacyDbConfigLayer } from "../../../shared/legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "../../../shared/legacy-db-connection.layer.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { legacyLoadProjectEnv } from "../../../shared/legacy-db-config.toml-read.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { LegacyDebugLogger } from "../../../shared/legacy-debug-logger.service.ts";
import { legacyDockerRunLayer } from "../../../shared/legacy-docker-run.layer.ts";
import { LegacyDockerRun } from "../../../shared/legacy-docker-run.service.ts";
import { legacyEdgeRuntimeScriptLayer } from "../../../shared/legacy-edge-runtime-script.layer.ts";
import { LegacyEdgeRuntimeScript } from "../../../shared/legacy-edge-runtime-script.service.ts";
import { legacyIdentityStitchLayer } from "../../../shared/legacy-identity-stitch.ts";
import { legacyPgDeltaSslProbeLayer } from "../../../shared/legacy-pgdelta-ssl-probe.layer.ts";
import { LegacyPgDeltaSslProbe } from "../../../shared/legacy-pgdelta-ssl-probe.service.ts";
import { legacyResolvePgDeltaImplementation } from "../../../shared/legacy-pgdelta-next-flag.ts";
import { legacyPgDeltaLegacyEngineLayer } from "./legacy-pgdelta-engine.legacy.layer.ts";
import { legacyPgDeltaNextEngineLayer } from "./legacy-pgdelta-engine.next.layer.ts";
import { LegacyPgDeltaEngine } from "./legacy-pgdelta-engine.service.ts";
import { legacyPgDeltaNextAdapterLayer } from "./legacy-pgdelta-next-adapter.layer.ts";
import { LegacyPgDeltaNextAdapter } from "./legacy-pgdelta-next-adapter.service.ts";
import { legacyPgDeltaNextShadowLayer } from "./legacy-pgdelta-next-shadow.layer.ts";
import { LegacyPgDeltaNextShadow } from "./legacy-pgdelta-next-shadow.service.ts";
import { legacyDeclarativeSeamLayer } from "./legacy-pgdelta.seam.layer.ts";
import { LegacyDeclarativeSeam } from "./legacy-pgdelta.seam.service.ts";

const FLAG = "SUPABASE_USE_PG_DELTA_NEXT";

export const legacyPgDeltaImplementationFlag = (
  shellValue: string | undefined,
  projectValue: string | undefined,
) => shellValue ?? projectValue;

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

/** Resolves the rollout flag once when the command-scoped layer is constructed. */
export const legacyPgDeltaEngineLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cliConfig = yield* LegacyCliConfig;
    const projectEnv = yield* legacyLoadProjectEnv(fs, path, cliConfig.workdir);
    // godotenv.Load never replaces a shell value, including an empty or invalid
    // one, so presence in process.env must suppress the project-file fallback.
    const raw = legacyPgDeltaImplementationFlag(process.env[FLAG], projectEnv[FLAG]);
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
  | LegacyDbConnection
  | LegacyDockerRun
  | FileSystem.FileSystem
  | Output
  | Path.Path
  | RuntimeInfo
  | CliArgs
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner
  | GlobalFlag.Setting.Identifier<"debug">
  | GlobalFlag.Setting.Identifier<"experimental">
  | GlobalFlag.Setting.Identifier<"network-id">
> {
  return implementation === "next" ? legacyPgDeltaNextEngineLayer : legacyPgDeltaLegacyEngineLayer;
}

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
