import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyOrgsList } from "./list.handler.ts";

const config = {};
export type LegacyOrgsListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyOrgsListCommand = Command.make("list", config).pipe(
  Command.withDescription("List all organizations the logged-in user belongs."),
  Command.withShortDescription("List all organizations"),
  Command.withHandler((flags) => legacyOrgsList(flags)),
);
