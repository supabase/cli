import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { QUERY_OUTPUT_FORMATS } from "../../../command-internal/go-output-flag.ts";
import { dbQuery } from "./query.handler.ts";
import { dbQueryRuntimeLayer } from "./query.layers.ts";

/**
 * `db query` needs its own `--output`/`-o` (`json|table|csv`), but Effect CLI keeps one global
 * flag registry that can't hold two `output` flags, so the global choice is the union of every
 * command's values instead. This handler reads the global flag, honors `json`/`table`/`csv`, and
 * defaults by agent mode (JSON for agents, table for humans) when unset. See SIDE_EFFECTS.md.
 */
const config = {
  sql: Argument.String("sql").pipe(
    Argument.withDescription("SQL query to execute."),
    Argument.optional,
  ),
  dbUrl: Flag.String("db-url").pipe(
    Flag.withDescription(
      "Queries the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  // Selects the linked path by presence, not value, so `--linked=false` still selects it.
  linked: Flag.Boolean("linked").pipe(
    Flag.withDescription("Queries the linked project's database via Management API."),
    Flag.optional,
  ),
  // In the same mutually-exclusive target group as `--db-url`/`--linked`, keyed off explicit
  // presence, so `--local=false` still counts as an explicit target in the conflict check.
  local: Flag.Boolean("local").pipe(
    Flag.withDescription("Queries the local database."),
    Flag.optional,
  ),
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  file: Flag.String("file").pipe(
    Flag.withAlias("f"),
    Flag.withDescription("Path to a SQL file to execute."),
    Flag.optional,
  ),
} as const;

export type DbQueryFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbQueryCommand = Command.make("query", config).pipe(
  Command.withDescription("Execute a SQL query against the database."),
  Command.withShortDescription("Execute a SQL query against the database"),
  Command.withHandler((flags) =>
    dbQuery(flags).pipe(
      withCommandTelemetry({
        flags: {
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "project-ref": flags.projectRef,
          file: flags.file,
        },
        // --project-ref isn't in the telemetry safe-flags list, so it stays redacted.
        outputFormats: QUERY_OUTPUT_FORMATS,
        // Telemetry reports changed flags by canonical name, so `-f query.sql` must log as `file`.
        aliases: { f: "file" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(dbQueryRuntimeLayer),
);
