import { Command } from "effect/cli";

import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { logoutRuntimeLayer } from "./logout.layers.ts";
import { logout } from "./logout.handler.ts";
import { withTargetPolicy } from "../../command-internal/target/target-policy.ts";
import { withPermissions } from "../../command-internal/command-permissions/command-permissions.annotation.ts";

export const logoutCommand = Command.make("logout").pipe(
  Command.withDescription(
    "Log out of your Supabase account by deleting the stored access token and project database passwords from this machine. " +
      "The tokens are not revoked on supabase.com.",
  ),
  Command.withShortDescription("Log out and delete local credentials"),
  Command.withExamples([
    {
      command: "supabase logout",
      description: "Delete the stored access token",
    },
  ]),
  withPermissions({ operations: [] }),
  Command.withHandler(() => logout().pipe(withCommandTelemetry(), withJsonErrorHandling)),
  Command.provide(logoutRuntimeLayer),
  withTargetPolicy({ group: "account", consent: "none" }),
);
