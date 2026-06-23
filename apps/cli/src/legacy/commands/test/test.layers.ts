import { Layer } from "effect";

import { legacyCliConfigLayer } from "../../config/legacy-cli-config.layer.ts";
import { legacyDbConfigLayer } from "../../shared/legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "../../shared/legacy-db-connection.layer.ts";
import { legacyDockerRunLayer } from "../../shared/legacy-docker-run.layer.ts";
import { legacyIdentityStitchLayer } from "../../shared/legacy-identity-stitch.ts";
import { legacyDebugLoggerLayer } from "../../shared/legacy-debug-logger.layer.ts";
import { legacyTelemetryStateLayer } from "../../telemetry/legacy-telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";

/**
 * Runtime layer for `supabase test db`.
 *
 * The Management API stack is intentionally NOT merged here: it resolves an
 * access token eagerly at build, which would break the auth-free `--local` /
 * `--db-url` paths. The `--linked` path provides it lazily inside the resolver
 * (`legacy-db-config.layer.ts`), so this layer only exposes the always-needed,
 * auth-free services. `legacyCliConfigLayer` is provided to the resolver AND
 * exposed at the top level (the handler yields it; `Layer.provide` does not
 * share to merge siblings — legacy CLAUDE.md item 5).
 */
const cliConfig = legacyCliConfigLayer.pipe(Layer.provide(legacyDebugLoggerLayer));

const dbConfig = legacyDbConfigLayer.pipe(
  Layer.provide(cliConfig),
  Layer.provide(legacyDbConnectionLayer),
  Layer.provide(legacyDebugLoggerLayer),
  // The resolver's lazy `--linked` stack snapshots the one per-command
  // `LegacyIdentityStitch` (Go's single root-context `sync.Once`).
  Layer.provide(legacyIdentityStitchLayer),
);

export const legacyTestDbRuntimeLayer = Layer.mergeAll(
  dbConfig,
  legacyDbConnectionLayer,
  legacyDockerRunLayer,
  cliConfig,
  // The one per-command identity stitcher (Go's single root-context `sync.Once`),
  // exposed at top level so `withLegacyCommandInstrumentation` can read
  // `stitchedDistinctId()` and attribute the cli_command_executed event to the
  // gotrue id. The SAME reference is provided to dbConfig above, so memoisation
  // gives the lazy linked stack a single `stitchAttempted` guard — aliasing/
  // persisting at most once. Mirrors lint.layers.ts / advisors.layers.ts.
  legacyIdentityStitchLayer,
  legacyTelemetryStateLayer,
  commandRuntimeLayer(["test", "db"]),
);
