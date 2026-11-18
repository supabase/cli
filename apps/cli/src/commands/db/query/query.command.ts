import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withCondition } from "../../../command-internal/command-permissions/model.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { QUERY_OUTPUT_FORMATS } from "../../../command-internal/output-formats.ts";
import { dbQuery } from "./query.handler.ts";
import { dbQueryRuntimeLayer } from "./query.layers.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliArgument, cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

/**
 * `db query` needs its own `--output`/`-o` (`json|table|csv`), but Effect CLI keeps one global
 * flag registry that can't hold two `output` flags, so the global choice is the union of every
 * command's values instead. This handler reads the global flag, honors `json`/`table`/`csv`, and
 * defaults by agent mode (JSON for agents, table for humans) when unset. See SIDE_EFFECTS.md.
 */
const config = {
  sql: cliArgument("sql", Argument.String, {
    description: "SQL statement to execute.",
    optional: true,
  }),
  ...targetFlags({ subject: "database", dbUrl: true }),
  file: cliFlag("file", Flag.String, {
    description: "Path to a SQL file to execute.",
    alias: "f",
    optional: true,
  }),
  readOnly: cliFlag("read-only", Flag.Boolean, {
    description:
      "Run the statement in a read-only transaction; a hosted target needs no confirmation.",
    default: false,
  }),
} as const;

export type DbQueryFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbQueryCommand = makeCommand("query", config).pipe(
  Command.withDescription(
    "Run a SQL statement, passed inline or from a file, and print the result. Use it for quick checks and scripts without a separate Postgres client.",
  ),
  Command.withShortDescription("Run a SQL query against a database"),
  Command.withExamples([
    {
      command: 'supabase db query "select count(*) from auth.users"',
      description: "Run a query against the local database",
    },
    {
      command: 'supabase db query --remote --read-only "select now()"',
      description: "Run a read-only query against the linked project",
    },
    {
      command: "supabase db query --file ./report.sql",
      description: "Run the statements in a SQL file",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [
          { operationId: "v1-run-a-query", kind: "required", when: [{ dbTarget: ["linked"] }] },
        ],
        noApiEffectFlags: ["file", "read-only"],
      },
      withCondition(linkedProjectCache, { dbTarget: ["linked"] }),
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    dbQuery(flags).pipe(
      withCommandTelemetry({
        flags: {
          file: flags.file,
          "read-only": flags.readOnly,
        },
        outputFormats: QUERY_OUTPUT_FORMATS,
        // Telemetry reports changed flags by canonical name, so `-f query.sql` must log as `file`.
        aliases: { f: "file" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(dbQueryRuntimeLayer),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "selectable", consent: "no" }),
);
