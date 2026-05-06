import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacySslEnforcementUpdate } from "./update.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  enableDbSslEnforcement: Flag.boolean("enable-db-ssl-enforcement").pipe(
    Flag.withDescription(
      "Whether the DB should enable SSL enforcement for all external connections.",
    ),
  ),
  disableDbSslEnforcement: Flag.boolean("disable-db-ssl-enforcement").pipe(
    Flag.withDescription(
      "Whether the DB should disable SSL enforcement for all external connections.",
    ),
  ),
} as const;

export type LegacySslEnforcementUpdateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacySslEnforcementUpdateCommand = Command.make("update", config).pipe(
  Command.withDescription("Update SSL enforcement configuration."),
  Command.withShortDescription("Update SSL enforcement configuration"),
  Command.withHandler((flags) => legacySslEnforcementUpdate(flags)),
);
