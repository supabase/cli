import { Layer } from "effect";

import { commandRuntimeLayer } from "../../../../../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../../../../../shared/runtime/stdin.layer.ts";
import { legacyCliConfigLayer } from "../../../../../config/legacy-cli-config.layer.ts";
import { legacyDbConfigLayer } from "../../../../../shared/legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "../../../../../shared/legacy-db-connection.layer.ts";
import { legacyDebugLoggerLayer } from "../../../../../shared/legacy-debug-logger.layer.ts";
import { legacyDockerRunLayer } from "../../../../../shared/legacy-docker-run.layer.ts";
import { legacyEdgeRuntimeScriptLayer } from "../../../../../shared/legacy-edge-runtime-script.layer.ts";
import { legacyIdentityStitchLayer } from "../../../../../shared/legacy-identity-stitch.ts";
import { legacyLinkedDbResolverRuntimeLayer } from "../../../../../shared/legacy-management-api-runtime.layer.ts";
import { legacyPgDeltaSslProbeLayer } from "../../../../../shared/legacy-pgdelta-ssl-probe.layer.ts";
import { legacyTelemetryStateLayer } from "../../../../../telemetry/legacy-telemetry-state.layer.ts";
import { legacyDeclarativeSeamLayer } from "../../../shared/legacy-pgdelta.seam.layer.ts";
import { legacyPgDeltaEngineLayer } from "../../../shared/legacy-pgdelta-engine.layer.ts";
import { legacyPgDeltaNextAdapterLayer } from "../../../shared/legacy-pgdelta-next-adapter.layer.ts";
import { legacyPgDeltaNextShadowLayer } from "../../../shared/legacy-pgdelta-next-shadow.layer.ts";

/**
 * Runtime layer for `supabase db schema declarative sync`. Sync diffs against the
 * local database, but its no-declarative-files bootstrap delegates to the shared
 * smart-generate flow (Go's `runDeclarativeGenerate`), which can target local /
 * linked / custom — so it needs the db-config resolver too. `Output` /
 * `LegacyGoProxy` / global flags + the Bun platform come from the legacy root /
 * `runCli`. `legacyDockerRunLayer` is ALSO exposed directly (not just provided to
 * `edgeRuntime`): both the smart-target bootstrap's local-reset prompt and the
 * failed-apply recovery reset now call `legacyResetLocalDatabase` in-process
 * (CLI-2062), whose PG15+ recreate reuses the same one-shot migrate jobs `db
 * start`/`db reset` back with this same layer (see those commands' own
 * `*.layers.ts`).
 */
const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

const dbConfig = legacyDbConfigLayer.pipe(
  Layer.provide(cliConfig),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(legacyDebugLoggerLayer),
  // The linked db-config resolver snapshots the single `LegacyIdentityStitch`
  // (Go's one `sync.Once`); the command runtime must provide it or the bundled
  // binary panics with a missing-service error (legacy CLAUDE.md rule 5).
  Layer.provide(legacyIdentityStitchLayer),
);

const edgeRuntime = legacyEdgeRuntimeScriptLayer.pipe(
  Layer.provide(legacyDockerRunLayer),
  Layer.provide(cliConfig),
);

const seam = legacyDeclarativeSeamLayer.pipe(Layer.provide(cliConfig));
const nextShadow = legacyPgDeltaNextShadowLayer.pipe(Layer.provide(seam));
const pgDeltaEngine = legacyPgDeltaEngineLayer.pipe(
  Layer.provide(legacyPgDeltaNextAdapterLayer),
  Layer.provide(nextShadow),
  Layer.provide(edgeRuntime),
  Layer.provide(legacyPgDeltaSslProbeLayer),
  Layer.provide(seam),
  Layer.provide(legacyDebugLoggerLayer),
);

export const legacyDbSchemaDeclarativeSyncRuntimeLayer = Layer.mergeAll(
  dbConfig,
  legacyDockerRunLayer,
  edgeRuntime,
  legacyPgDeltaSslProbeLayer,
  seam,
  pgDeltaEngine,
  legacyDbConnectionLayer,
  cliConfig,
  legacyIdentityStitchLayer,
  legacyTelemetryStateLayer,
  // Go's PersistentPostRun writes the linked-project cache when the bootstrap path
  // resolved a linked ref; this bundle supplies `LegacyLinkedProjectCache` (+ the
  // lazy Management-API runtime it needs), mirroring `generate` (`generate.layers.ts`).
  legacyLinkedDbResolverRuntimeLayer(["db", "schema", "declarative", "sync"]).pipe(
    Layer.provide(legacyIdentityStitchLayer),
  ),
  commandRuntimeLayer(["db", "schema", "declarative", "sync"]),
  // `stdinLayer`: the confirmation prompts route through `legacyPromptYesNo`,
  // whose non-TTY branch reads piped stdin (Go's `Console.ReadLine`).
  stdinLayer,
);
