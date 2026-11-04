import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbCollationDrift } from "./collation-drift.handler.ts";
import {
  INSPECT_DB_FLAGS,
  INSPECT_DB_PERMISSIONS,
  inspectDbCommandHandler,
  withInspectDbTargetPolicy,
} from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";
import { cliConfigValuesLayer } from "../../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../../config/cli-config-flags.ts";
import { makeCommand } from "../../../../shared/cli/cli-params.ts";

export const inspectDbCollationDriftCommand = makeCommand("collation-drift", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    `Show indexes affected by collation version drift, with the fix workflow.

Postgres stores btree indexes on text columns in sorted order, using rules from
the system collation library (glibc or ICU). When that library is upgraded the
rules can change, and indexes built under the old rules are no longer correctly
ordered. Postgres reports no error: queries may quietly return missing rows,
sort incorrectly, or let duplicates past a unique constraint.

The output lists the affected indexes and the exact statements to verify
(amcheck), rebuild (REINDEX CONCURRENTLY), and record the new version — in the
order they must be run. This command itself is read-only.`,
  ),
  Command.withShortDescription("Show indexes affected by collation version drift"),
  Command.withExamples([
    {
      command: "supabase inspect db collation-drift",
      description: "List drifted indexes on the local database",
    },
    {
      command: "supabase inspect db collation-drift --remote",
      description: "List drifted indexes on the linked project",
    },
  ]),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbCollationDrift)),
  Command.provide(inspectDbRuntimeLayer("collation-drift")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
  withInspectDbTargetPolicy,
);
