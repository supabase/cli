import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import {
  compose,
  withCondition,
  withDbTarget,
} from "../../../command-internal/command-permissions/model.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { QUERY_OUTPUT_FORMATS } from "../../../command-internal/output-formats.ts";
import { dbQuery } from "./query.handler.ts";
import { dbQueryRuntimeLayer } from "./query.layers.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { targetFlags } from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

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
  ...targetFlags({ subject: "database", dbUrl: true }),
  file: Flag.String("file").pipe(
    Flag.withAlias("f"),
    Flag.withDescription("Path to a SQL file to execute."),
    Flag.optional,
  ),
  readOnly: Flag.Boolean("read-only").pipe(
    Flag.withDescription(
      "Runs the statement in a read-only transaction; a hosted target needs no confirmation.",
    ),
    Flag.withDefault(false),
  ),
} as const;

export type DbQueryFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbQueryCommand = Command.make("query", config).pipe(
  Command.withDescription("Execute a SQL query against the database."),
  Command.withShortDescription("Execute a SQL query against the database"),
  withPermissions(
    withDbTarget(
      compose(
        {
          operations: [
            { operationId: "v1-run-a-query", kind: "required", when: [{ dbTarget: ["linked"] }] },
          ],
          noApiEffectFlags: ["file", "project-ref", "read-only"],
        },
        withCondition(linkedProjectCache, { dbTarget: ["linked"] }),
      ),
      { default: "local" },
    ),
  ),
  Command.withHandler((flags) =>
    dbQuery(flags).pipe(
      withCommandTelemetry({
        flags: {
          remote: flags.remote,
          "db-url": flags.dbUrl,
          linked: flags.linked,
          local: flags.local,
          "project-ref": flags.projectRef,
          file: flags.file,
          "read-only": flags.readOnly,
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
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "selectable", consent: "no" }),
);
