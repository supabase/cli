import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInspectDbRoleConfigs } from "./role-configs.handler.ts";

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

export type LegacyInspectDbRoleConfigsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInspectDbRoleConfigsCommand = Command.make("role-configs", config).pipe(
  Command.withDescription(
    'Show configuration settings for database roles when they have been modified. Deprecated: use "role-stats" instead.',
  ),
  Command.withShortDescription("Show role configs (deprecated)"),
  Command.withHandler((flags) => legacyInspectDbRoleConfigs(flags)),
);
