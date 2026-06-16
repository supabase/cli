import { Layer } from "effect";

import { legacyCliConfigLayer } from "../../config/legacy-cli-config.layer.ts";
import { legacyDbConfigLayer } from "../../shared/legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "../../shared/legacy-db-connection.layer.ts";
import { legacyIdentityStitchLayer } from "../../shared/legacy-identity-stitch.ts";
import { legacyDebugLoggerLayer } from "../../shared/legacy-debug-logger.layer.ts";
import { legacyTelemetryStateLayer } from "../../telemetry/legacy-telemetry-state.layer.ts";

/**
 * `legacyCliConfigLayer` is provided to the resolver AND exposed at the top level
 * because `Layer.provide` does not share to merge siblings (legacy CLAUDE.md item
 * 5); the resolver requires it internally and so it is provided to `dbConfig`,
 * while the merge keeps it available alongside.
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

/**
 * The services every `inspect` leaf shares, minus the command-runtime identity:
 * the DB-config resolver, the Postgres connection, the CLI config (for the
 * `--workdir` config rules `inspect report` reads), and telemetry state. Mirrors
 * `test/test.layers.ts` minus the docker layer.
 *
 * The Management API stack is NOT merged here — it resolves an access token
 * eagerly, which would break the auth-free `--local` / `--db-url` paths. The
 * `--linked` path provides it lazily inside the resolver (`legacy-db-config.layer.ts`).
 *
 * Hoisted out of `db/db.layers.ts` so both the `inspect db <leaf>` subcommands and
 * `inspect report` (a sibling of `db`, not a child) share one definition rather
 * than each carrying a parallel copy.
 */
export const legacyInspectBaseLayer = Layer.mergeAll(
  dbConfig,
  legacyDbConnectionLayer,
  cliConfig,
  // The one per-command identity stitcher (Go's single root-context `sync.Once`),
  // exposed at top level so `withLegacyCommandInstrumentation` can read
  // `stitchedDistinctId()` and attribute the cli_command_executed event to the
  // gotrue id. The SAME reference is provided to dbConfig above, so memoisation
  // gives the lazy linked stack and the instrumentation hook the same
  // `stitchAttempted` guard — aliasing/persisting at most once. Its
  // Analytics / TelemetryRuntime / FileSystem / Path deps are ambient (root
  // runtime). Mirrors advisors.layers.ts / lint.layers.ts.
  legacyIdentityStitchLayer,
  legacyTelemetryStateLayer,
);
