import { Command } from "effect/unstable/cli";
import { legacyInspectDbRoleConnections } from "./role-connections.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbRoleConnectionsCommand = Command.make(
  "role-connections",
  LEGACY_INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription(
    'Show number of active connections for all database roles. Deprecated: use "role-stats" instead.',
  ),
  Command.withShortDescription("Show role connections (deprecated)"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbRoleConnections)),
  Command.provide(legacyInspectDbRuntimeLayer("role-connections")),
);
