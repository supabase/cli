import { Command } from "effect/unstable/cli";
import { legacyInspectDbRoleConfigs } from "./role-configs.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbRoleConfigsCommand = Command.make(
  "role-configs",
  LEGACY_INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription(
    'Show configuration settings for database roles when they have been modified. Deprecated: use "role-stats" instead.',
  ),
  Command.withShortDescription("Show role configs (deprecated)"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbRoleConfigs)),
  Command.provide(legacyInspectDbRuntimeLayer("role-configs")),
);
