import { Layer } from "effect";

import { legacyCliConfigLayer } from "../../../config/legacy-cli-config.layer.ts";
import { legacyDbConfigLayer } from "../../../shared/legacy-db-config.layer.ts";
import { legacyDbConnectionLayer } from "../../../shared/legacy-db-connection.layer.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";

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
);

/**
 * The services every `inspect db` subcommand shares, minus the command-runtime
 * identity. Mirrors `test/test.layers.ts` minus the docker layer: the DB-config
 * resolver, the Postgres connection, the CLI config, and telemetry state. The
 * Management API stack is NOT merged here — it resolves an access token eagerly,
 * which would break the auth-free `--local` / `--db-url` paths. The `--linked`
 * path provides it lazily inside the resolver (`legacy-db-config.layer.ts`).
 */
const baseLayer = Layer.mergeAll(
  dbConfig,
  legacyDbConnectionLayer,
  cliConfig,
  legacyTelemetryStateLayer,
);

/**
 * The command-runtime path for a single `inspect db <leaf>` subcommand.
 *
 * The `leaf` is the cobra `Use` name of the invoked command (e.g. `"locks"`, or a
 * deprecated alias like `"cache-hit"`) and is appended to `["inspect", "db"]`. This
 * path is what `withLegacyCommandInstrumentation` records as the PostHog
 * `cli_command_executed` `command` property, matching Go's `cmd.CommandPath()`
 * (`apps/cli-go/cmd/root_analytics.go:32-38`): Go's inspect tree is a real 3-level
 * hierarchy, so each of the 25 leaves emits a distinct command name. A shared
 * `["inspect", "db"]` path would collapse them all into one event, so each leaf must
 * pass its own name — and a deprecated alias records the alias the user typed, not
 * the backend command it delegates to (`cmd/inspect.go:139-247`).
 */
export const legacyInspectDbCommandPath = (leaf: string): ReadonlyArray<string> => [
  "inspect",
  "db",
  leaf,
];

/** Runtime layer for a single `supabase inspect db <leaf>` subcommand. */
export const legacyInspectDbRuntimeLayer = (leaf: string) =>
  Layer.merge(baseLayer, commandRuntimeLayer(legacyInspectDbCommandPath(leaf)));
