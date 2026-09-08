import { Command } from "effect/unstable/cli";
import { inspectDbSeqScans } from "./seq-scans.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbSeqScansCommand = Command.make("seq-scans", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    'Show number of sequential scans recorded against all tables. Deprecated: use "index-stats" instead.',
  ),
  Command.withShortDescription("Show sequential scans (deprecated)"),
  Command.withHandler(inspectDbCommandHandler(inspectDbSeqScans)),
  Command.provide(inspectDbRuntimeLayer("seq-scans")),
);
