import { Argument, Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyOrgsCreate } from "./create.handler.ts";

const config = {
  name: Argument.string("name").pipe(
    Argument.withDescription("Name of the organization to create."),
  ),
};
export type LegacyOrgsCreateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyOrgsCreateCommand = Command.make("create", config).pipe(
  Command.withDescription("Create an organization for the logged-in user."),
  Command.withShortDescription("Create an organization"),
  Command.withHandler((flags) => legacyOrgsCreate(flags)),
);
