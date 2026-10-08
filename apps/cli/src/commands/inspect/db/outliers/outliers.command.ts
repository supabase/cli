import { Command } from "effect/unstable/cli";
import { inspectDbOutliers } from "./outliers.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";
import { cliConfigValuesLayer } from "../../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../../config/cli-config-flags.ts";

export const inspectDbOutliersCommand = Command.make("outliers", INSPECT_DB_FLAGS).pipe(
  Command.withDescription("Show queries from pg_stat_statements ordered by total execution time."),
  Command.withShortDescription("Show query outliers by time"),
  Command.withHandler(inspectDbCommandHandler(inspectDbOutliers)),
  Command.provide(inspectDbRuntimeLayer("outliers")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
);
