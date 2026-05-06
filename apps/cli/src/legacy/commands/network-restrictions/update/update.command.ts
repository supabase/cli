import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyNetworkRestrictionsUpdate } from "./update.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  dbAllowCidr: Flag.string("db-allow-cidr").pipe(
    Flag.withDescription("CIDR to allow DB connections from."),
    Flag.atLeast(0),
  ),
  bypassCidrChecks: Flag.boolean("bypass-cidr-checks").pipe(
    Flag.withDescription("Bypass some of the CIDR validation checks."),
  ),
  append: Flag.boolean("append").pipe(
    Flag.withDescription("Append to existing restrictions instead of replacing them."),
  ),
} as const;

export type LegacyNetworkRestrictionsUpdateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyNetworkRestrictionsUpdateCommand = Command.make("update", config).pipe(
  Command.withDescription("Update network restrictions."),
  Command.withShortDescription("Update network restrictions"),
  Command.withHandler((flags) => legacyNetworkRestrictionsUpdate(flags)),
);
