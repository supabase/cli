import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInspectDbRoleConnections } from "./role-connections.handler.ts";

const config = {
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Inspect the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(Flag.withDescription("Inspect the linked project.")),
  local: Flag.boolean("local").pipe(Flag.withDescription("Inspect the local database.")),
} as const;

export type LegacyInspectDbRoleConnectionsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInspectDbRoleConnectionsCommand = Command.make("role-connections", config).pipe(
  Command.withDescription(
    'Show number of active connections for all database roles. Deprecated: use "role-stats" instead.',
  ),
  Command.withShortDescription("Show role connections (deprecated)"),
  Command.withHandler((flags) => legacyInspectDbRoleConnections(flags)),
);
