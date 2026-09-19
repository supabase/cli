import { Command } from "effect/unstable/cli";
import { inspectDbCollationDrift } from "./collation-drift.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbCollationDriftCommand = Command.make(
  "collation-drift",
  INSPECT_DB_FLAGS,
).pipe(
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
  Command.withHandler(inspectDbCommandHandler(inspectDbCollationDrift)),
  Command.provide(inspectDbRuntimeLayer("collation-drift")),
);
