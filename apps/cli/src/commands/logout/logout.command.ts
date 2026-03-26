import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { credentialsLayer } from "../../auth/credentials.layer.ts";
import { withJsonErrorHandling } from "../../output/json-error-handling.ts";
import { logout } from "./logout.handler.ts";

export const logoutCommand = Command.make("logout", {
  yes: Flag.boolean("yes").pipe(Flag.withDescription("Skip the confirmation prompt")),
}).pipe(
  Command.withDescription("Log out of Supabase and remove the stored access token."),
  Command.withShortDescription("Log out of Supabase"),
  Command.withHandler(({ yes }) =>
    logout(yes).pipe(Effect.withSpan("command.logout"), withJsonErrorHandling),
  ),
  Command.provide(credentialsLayer),
);
