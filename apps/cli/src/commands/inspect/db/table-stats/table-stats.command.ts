import { Command } from "effect/unstable/cli";
import { inspectDbTableStats } from "./table-stats.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";
import { cliConfigValuesLayer } from "../../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../../config/cli-config-flags.ts";

export const inspectDbTableStatsCommand = Command.make("table-stats", INSPECT_DB_FLAGS).pipe(
  Command.withDescription("Show combined table size, index size, and estimated row count."),
  Command.withShortDescription("Show table stats"),
  Command.withHandler(inspectDbCommandHandler(inspectDbTableStats)),
  Command.provide(inspectDbRuntimeLayer("table-stats")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
);
