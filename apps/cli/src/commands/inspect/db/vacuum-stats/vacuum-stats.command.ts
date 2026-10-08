import { Command } from "effect/unstable/cli";
import { inspectDbVacuumStats } from "./vacuum-stats.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";
import { cliConfigValuesLayer } from "../../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../../config/cli-config-flags.ts";

export const inspectDbVacuumStatsCommand = Command.make("vacuum-stats", INSPECT_DB_FLAGS).pipe(
  Command.withDescription("Show statistics related to vacuum operations per table."),
  Command.withShortDescription("Show vacuum stats"),
  Command.withHandler(inspectDbCommandHandler(inspectDbVacuumStats)),
  Command.provide(inspectDbRuntimeLayer("vacuum-stats")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
);
