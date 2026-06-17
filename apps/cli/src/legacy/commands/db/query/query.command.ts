import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { LEGACY_QUERY_OUTPUT_FORMATS } from "../../../shared/legacy-go-output-flag.ts";
import { legacyDbQuery } from "./query.handler.ts";
import { legacyDbQueryRuntimeLayer } from "./query.layers.ts";

/**
 * NOTE on `--output` / `-o`: Go registers a command-local `--output`/`-o`
 * (`json|table|csv`) that shadows the global one. The Effect CLI extracts global
 * flags from the whole token stream **before** the leaf parse and builds one
 * tree-wide registry, so a duplicate command-scoped `output` global is impossible
 * (`Parser.createFlagRegistry` throws on duplicate names). Instead the global
 * `LegacyOutputFlag` choice is the UNION of every command's `--output` values
 * (`env|pretty|json|toml|yaml|table|csv`); this handler reads the global and
 * honors `json`, `table`, and `csv` — `db query`'s Go enum — defaulting by agent
 * mode (JSON for agents, table for humans) when `-o` is unset. See SIDE_EFFECTS.md.
 */
const config = {
  sql: Argument.string("sql").pipe(
    Argument.withDescription("SQL query to execute."),
    Argument.optional,
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Queries the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  // Go's `db query` defaults `--linked` to false and never reads its value; the
  // linked-vs-local decision is driven entirely by `flag.Changed` in both PreRunE
  // and RunE (`apps/cli-go/cmd/db.go:301,329,524`). Model presence (not value) with
  // `Option` — the same way `--db-url` does — so `--linked=false` still selects the
  // linked path (pflag marks an explicit assignment as changed), matching Go.
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Queries the linked project's database via Management API."),
    Flag.optional,
  ),
  // Go puts `--local` in the same mutually-exclusive target group as `--db-url`/
  // `--linked` (`cmd/db.go:526`) and cobra keys the conflict off `flag.Changed`, not
  // the value (`--local` even defaults to true), so model presence with `Option` so
  // `--local=false` still counts as an explicit target in the conflict check.
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Queries the local database."),
    Flag.optional,
  ),
  file: Flag.string("file").pipe(
    Flag.withAlias("f"),
    Flag.withDescription("Path to a SQL file to execute."),
    Flag.optional,
  ),
} as const;

export type LegacyDbQueryFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbQueryCommand = Command.make("query", config).pipe(
  Command.withDescription("Execute a SQL query against the database."),
  Command.withShortDescription("Execute a SQL query against the database"),
  Command.withHandler((flags) =>
    legacyDbQuery(flags).pipe(
      withLegacyCommandInstrumentation({
        flags: {
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          file: flags.file,
        },
        // db query's Go enum is `json|table|csv`, not the resource-command set.
        outputFormats: LEGACY_QUERY_OUTPUT_FORMATS,
        // Go registers `--file` with shorthand `-f` (`cmd/db.go:527`) and telemetry
        // reports changed flags by canonical `flag.Name` via `flags.Visit`
        // (`cmd/root_analytics.go`), so `-f query.sql` must log as `file`. `f` is
        // query's only telemetry-relevant shorthand. Mirrors dump.command.ts.
        aliases: { f: "file" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyDbQueryRuntimeLayer),
);
