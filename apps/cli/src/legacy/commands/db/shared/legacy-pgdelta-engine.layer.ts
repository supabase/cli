import { Effect, FileSystem, Layer, Path } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type { GlobalFlag } from "effect/unstable/cli";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { legacyLoadProjectEnv } from "../../../shared/legacy-db-config.toml-read.ts";
import { LegacyDebugLogger } from "../../../shared/legacy-debug-logger.service.ts";
import { LegacyDockerRun } from "../../../shared/legacy-docker-run.service.ts";
import { LegacyEdgeRuntimeScript } from "../../../shared/legacy-edge-runtime-script.service.ts";
import { LegacyPgDeltaSslProbe } from "../../../shared/legacy-pgdelta-ssl-probe.service.ts";
import { legacyPgDeltaLegacyEngineLayer } from "./legacy-pgdelta-engine.legacy.layer.ts";
import { legacyPgDeltaNextEngineLayer } from "./legacy-pgdelta-engine.next.layer.ts";
import { LegacyPgDeltaEngine } from "./legacy-pgdelta-engine.service.ts";
import { LegacyPgDeltaNextAdapter } from "./legacy-pgdelta-next-adapter.service.ts";
import { LegacyPgDeltaNextShadow } from "./legacy-pgdelta-next-shadow.service.ts";
import { LegacyDeclarativeSeam } from "./legacy-pgdelta.seam.service.ts";
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

/** Resolves the rollout flag once when the command-scoped layer is constructed. */
export const legacyPgDeltaEngineLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cliConfig = yield* LegacyCliConfig;
    const projectEnv = yield* legacyLoadProjectEnv(fs, path, cliConfig.workdir);
    // godotenv.Load never replaces a shell value, including an empty or invalid
    // one, so presence in process.env must suppress the project-file fallback.
    const raw = process.env[FLAG] ?? projectEnv[FLAG];
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
