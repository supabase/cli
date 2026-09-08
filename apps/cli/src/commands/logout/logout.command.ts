import { Command } from "effect/unstable/cli";

import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { logoutRuntimeLayer } from "./logout.layers.ts";
import { logout } from "./logout.handler.ts";

export const logoutCommand = Command.make("logout").pipe(
  Command.withDescription("Log out and delete access tokens locally."),
  Command.withShortDescription("Log out and delete access tokens locally"),
  Command.withHandler(() => logout().pipe(withCommandTelemetry(), withJsonErrorHandling)),
  Command.provide(logoutRuntimeLayer),
);
