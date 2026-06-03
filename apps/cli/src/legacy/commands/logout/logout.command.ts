import { Command } from "effect/unstable/cli";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../telemetry/legacy-command-instrumentation.ts";
import { legacyLogoutRuntimeLayer } from "./logout.layers.ts";
import { legacyLogout } from "./logout.handler.ts";

export const legacyLogoutCommand = Command.make("logout").pipe(
  Command.withDescription("Log out and delete access tokens locally."),
  Command.withShortDescription("Log out and delete access tokens locally"),
  Command.withHandler(() =>
    legacyLogout().pipe(withLegacyCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(legacyLogoutRuntimeLayer),
);
