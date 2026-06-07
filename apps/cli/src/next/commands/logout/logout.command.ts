import { Command, Flag } from "effect/unstable/cli";
import { credentialsLayer } from "../../auth/credentials.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../../shared/telemetry/command-instrumentation.ts";
import { logout } from "./logout.handler.ts";

export const logoutCommand = Command.make("logout", {
  yes: Flag.boolean("yes").pipe(Flag.withDescription("Skip the confirmation prompt")),
}).pipe(
  Command.withDescription("Log out of Supabase and remove the stored access token."),
  Command.withShortDescription("Log out of Supabase"),
  Command.withHandler(({ yes }) =>
    logout(yes).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["logout"])),
  Command.provide(credentialsLayer),
);
