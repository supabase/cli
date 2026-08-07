import { Layer } from "effect";

import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { legacyHttpClientLayer } from "../../../auth/legacy-http-debug.layer.ts";
import { legacyCliConfigLayer } from "../../../config/legacy-cli-config.layer.ts";
import { legacyDbConfigLayer } from "../../../shared/legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "../../../shared/legacy-db-connection.layer.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { legacyDockerRunLayer } from "../../../shared/legacy-docker-run.layer.ts";
import { legacyEdgeRuntimeScriptLayer } from "../../../shared/legacy-edge-runtime-script.layer.ts";
import { legacyIdentityStitchLayer } from "../../../shared/legacy-identity-stitch.ts";
import { legacyLinkedDbResolverRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { legacyPgDeltaSslProbeLayer } from "../../../shared/legacy-pgdelta-ssl-probe.layer.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";

/**
 * Runtime layer for `supabase db diff`.
 *
 * Mirrors `db schema declarative generate` (`generate.layers.ts`): the db-config
 * resolver plus the native pg-delta / migra stack — the edge-runtime runner, the
 * SSL probe, and `HttpClient` (the native shadow's health-check wait). Shadow
 * provisioning (both `db diff`'s own and the explicit `--from migrations`/`--to
 * migrations` catalog shadow) is fully native (CLI-1956/CLI-1959) — see
 * `commands/db/shared/legacy-shadow-source.ts` and `shared/legacy-pgdelta.cache.ts`
 * — so no `LegacyDeclarativeSeam` layer is needed here (`--use-pgadmin`/
 * `--use-pg-schema` delegate through `LegacyGoProxy` instead, not this seam).
 * `LegacyDockerRun` is exposed in the merge (not just provided to the
 * edge-runtime layer) because the migra OOM bash fallback runs the
 * `supabase/migra` container directly.
 * Per the "provide doesn't share to siblings" rule, `LegacyCliConfig` is provided
 * to every layer that needs it.
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

const httpClient = legacyHttpClientLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

export const legacyDbDiffRuntimeLayer = Layer.mergeAll(
  dbConfig,
  legacyDbConnectionLayer,
  legacyDockerRunLayer,
  edgeRuntime,
  legacyPgDeltaSslProbeLayer,
  httpClient,
  cliConfig,
  legacyIdentityStitchLayer,
  legacyTelemetryStateLayer,
  // Go's PersistentPostRun writes the linked-project cache for `--linked`; this
  // bundle supplies `LegacyLinkedProjectCache` (+ the lazy Management-API runtime
  // it needs), mirroring `db schema declarative generate`.
  legacyLinkedDbResolverRuntimeLayer(["db", "diff"]).pipe(Layer.provide(legacyIdentityStitchLayer)),
  commandRuntimeLayer(["db", "diff"]),
);
