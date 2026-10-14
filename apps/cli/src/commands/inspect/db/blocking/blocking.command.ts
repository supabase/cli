import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbBlocking } from "./blocking.handler.ts";
import {
  INSPECT_DB_FLAGS,
  INSPECT_DB_PERMISSIONS,
  inspectDbCommandHandler,
} from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbBlockingCommand = Command.make("blocking", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    "Show queries that are holding locks and the queries that are waiting for them to be released.",
  ),
  Command.withShortDescription("Show blocking queries"),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbBlocking)),
  Command.provide(inspectDbRuntimeLayer("blocking")),
);
