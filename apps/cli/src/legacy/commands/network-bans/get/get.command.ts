import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyNetworkBansGet } from "./get.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
};

export type LegacyNetworkBansGetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyNetworkBansGetCommand = Command.make("get", config).pipe(
  Command.withDescription("Get the current network bans."),
  Command.withShortDescription("Get the current network bans"),
  Command.withHandler((flags) => legacyNetworkBansGet(flags)),
);
