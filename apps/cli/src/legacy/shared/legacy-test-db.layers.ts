import { Layer } from "effect";

import { legacyCliConfigLayer } from "../config/legacy-cli-config.layer.ts";
import { legacyDbConfigLayer } from "./legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "./legacy-db-connection.layer.ts";
import { legacyDockerRunLayer } from "./legacy-docker-run.layer.ts";
import { legacyIdentityStitchLayer } from "./legacy-identity-stitch.ts";
import { legacyDebugLoggerLayer } from "./legacy-debug-logger.layer.ts";
import { legacyTelemetryStateLayer } from "../telemetry/legacy-telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";

/**
 * Runtime layer shared by `supabase test db` and its hidden Go-parity alias
 * `supabase db test` (`apps/cli/src/legacy/commands/db/test/test.command.ts`).
 * Go registers these as two distinct `cobra.Command`s that share the literal
 * same `RunE` (`apps/cli-go/cmd/test.go:19-20`, deleted in CLI-1970; last
 * present at commit 7b469f5b3: `RunE: dbTestCmd.RunE`); the TS
 * port mirrors that by having both `.command.ts` files call this same factory
 * and `legacyRunTestDbCommand`.
 *
 * The Management API stack is intentionally NOT merged here: it resolves an
 * access token eagerly at build, which would break the auth-free `--local` /
 * `--db-url` paths. The `--linked` path provides it lazily inside the resolver
 * (`legacy-db-config.layer.ts`), so this layer only exposes the always-needed,
 * auth-free services. `legacyCliConfigLayer` is provided to the resolver AND
 * exposed at the top level (the handler yields it; `Layer.provide` does not
 * share to merge siblings — legacy CLAUDE.md item 5).
 *
 * `commandPath` must reflect the ACTUAL invoked command path (`["test", "db"]`
 * or `["db", "test"]`): Go's `cli_command_executed` telemetry records
 * `strings.TrimSpace(cmd.CommandPath())` (`cmd/root_analytics.go:33`), which
 * differs between the two entry points even though the underlying `RunE` is
 * identical — the TS `command` telemetry property and trace span name must
 * differ the same way (see `commandRuntimeLayer`).
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

export const legacyTestDbRuntimeLayer = (commandPath: ReadonlyArray<string>) =>
  Layer.mergeAll(
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
    commandRuntimeLayer(commandPath),
  );
