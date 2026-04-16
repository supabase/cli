import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyLogin } from "./login.handler.ts";

const config = {
  token: Flag.string("token").pipe(
    Flag.withDescription("Use provided token instead of automatic login flow."),
    Flag.optional,
  ),
  name: Flag.string("name").pipe(
    Flag.withDescription("Name that will be used to store token in your settings."),
    Flag.optional,
  ),
  noBrowser: Flag.boolean("no-browser").pipe(
    Flag.withDescription("Do not open browser automatically."),
  ),
} as const;

export type LegacyLoginFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyLoginCommand = Command.make("login", config).pipe(
  Command.withDescription("Authenticate using an access token."),
  Command.withShortDescription("Authenticate using an access token"),
  Command.withHandler((flags) => legacyLogin(flags)),
);
