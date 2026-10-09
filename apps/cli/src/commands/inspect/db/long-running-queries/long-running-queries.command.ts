import { Command } from "effect/unstable/cli";
import { inspectDbLongRunningQueries } from "./long-running-queries.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";
import { cliConfigValuesLayer } from "../../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../../config/cli-config-flags.ts";

export const inspectDbLongRunningQueriesCommand = Command.make(
  "long-running-queries",
  INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription("Show currently running queries running for longer than 5 minutes."),
  Command.withShortDescription("Show long-running queries"),
  Command.withHandler(inspectDbCommandHandler(inspectDbLongRunningQueries)),
  Command.provide(inspectDbRuntimeLayer("long-running-queries")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
);
