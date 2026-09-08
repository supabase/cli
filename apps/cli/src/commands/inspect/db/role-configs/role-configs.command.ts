import { Command } from "effect/unstable/cli";
import { inspectDbRoleConfigs } from "./role-configs.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbRoleConfigsCommand = Command.make("role-configs", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    'Show configuration settings for database roles when they have been modified. Deprecated: use "role-stats" instead.',
  ),
  Command.withShortDescription("Show role configs (deprecated)"),
  Command.withHandler(inspectDbCommandHandler(inspectDbRoleConfigs)),
  Command.provide(inspectDbRuntimeLayer("role-configs")),
);
