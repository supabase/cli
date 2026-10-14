import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbLongRunningQueries } from "./long-running-queries.handler.ts";
import {
  INSPECT_DB_FLAGS,
  INSPECT_DB_PERMISSIONS,
  inspectDbCommandHandler,
} from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbLongRunningQueriesCommand = Command.make(
  "long-running-queries",
  INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription("Show currently running queries running for longer than 5 minutes."),
  Command.withShortDescription("Show long-running queries"),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbLongRunningQueries)),
  Command.provide(inspectDbRuntimeLayer("long-running-queries")),
);
