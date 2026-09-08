import { Command } from "effect/unstable/cli";
import { inspectDbRoleConnections } from "./role-connections.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbRoleConnectionsCommand = Command.make(
  "role-connections",
  INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription(
    'Show number of active connections for all database roles. Deprecated: use "role-stats" instead.',
  ),
  Command.withShortDescription("Show role connections (deprecated)"),
  Command.withHandler(inspectDbCommandHandler(inspectDbRoleConnections)),
  Command.provide(inspectDbRuntimeLayer("role-connections")),
);
