import { Command } from "effect/unstable/cli";
import { legacyLogout } from "./logout.handler.ts";

export const legacyLogoutCommand = Command.make("logout").pipe(
  Command.withDescription("Log out and delete access tokens locally."),
  Command.withShortDescription("Log out and delete access tokens locally"),
  Command.withHandler(() => legacyLogout()),
);
