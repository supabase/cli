import { Layer } from "effect";

import { commandSettingsLayer } from "../../config/command-settings.layer.ts";
import { dbConfigLayer } from "../../command-internal/db-config.layer.ts";
import { dbConnectionLayer } from "../../command-internal/db-connection.layer.ts";
import { identityStitchLayer } from "../../command-internal/identity-stitch.ts";
import { debugLoggerLayer } from "../../command-internal/debug-logger.layer.ts";
import { telemetryStateLayer } from "../../telemetry/telemetry-state.layer.ts";

/**
 * `commandSettingsLayer` is provided to the resolver AND exposed at the top level
 * because `Layer.provide` does not share to merge siblings (legacy CLAUDE.md item
 * 5); the resolver requires it internally and so it is provided to `dbConfig`,
 * while the merge keeps it available alongside.
 */
const cliSettings = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));

const dbConfig = dbConfigLayer.pipe(
  Layer.provide(cliSettings),
  Layer.provide(dbConnectionLayer),
  Layer.provide(debugLoggerLayer),
  // The resolver's lazy `--linked` stack snapshots the one per-command
  // `IdentityStitch` — a single memoized identity-stitch attempt.
  Layer.provide(identityStitchLayer),
);

/**
 * The services every `inspect` leaf shares, minus the command-runtime identity:
 * the DB-config resolver, the Postgres connection, the CLI config (for the
 * `--workdir` config rules `inspect report` reads), and telemetry state. Mirrors
 * `command-internal/test-db.layers.ts` minus the docker layer.
 *
 * The Management API stack is NOT merged here — it resolves an access token
 * eagerly, which would break the auth-free `--local` / `--db-url` paths. The
 * `--linked` path provides it lazily inside the resolver (`db-config.layer.ts`).
 *
 * Hoisted out of `db/db.layers.ts` so both the `inspect db <leaf>` subcommands and
 * `inspect report` (a sibling of `db`, not a child) share one definition rather
 * than each carrying a parallel copy.
 */
export const inspectBaseLayer = Layer.mergeAll(
  dbConfig,
  dbConnectionLayer,
  cliSettings,
  // The one per-command identity stitcher — a single memoized identity-stitch
  // attempt — exposed at top level so `withCommandTelemetry` can read
  // `stitchedDistinctId()` and attribute the cli_command_executed event to the
  // gotrue id. The SAME reference is provided to dbConfig above, so memoisation
  // gives the lazy linked stack and the instrumentation hook the same
  // `stitchAttempted` guard — aliasing/persisting at most once. Its
  // Analytics / TelemetryRuntime / FileSystem / Path deps are ambient (root
  // runtime). Mirrors advisors.layers.ts / lint.layers.ts.
  identityStitchLayer,
  telemetryStateLayer,
);
