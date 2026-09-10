import type * as CliCommand from "effect/unstable/cli/Command";
import { Command } from "effect/unstable/cli";

import { GLOBAL_OUTPUT_FORMATS } from "../../command-internal/global-flags.ts";
import { managementApiRuntimeLayer } from "../../command-internal/management-api-runtime.layer.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { whoami } from "./whoami.handler.ts";

const config = {};
export type WhoamiFlags = CliCommand.Command.Config.Infer<typeof config>;

const whoamiHandler = (flags: WhoamiFlags) =>
  whoami(flags).pipe(
    withCommandTelemetry({
      flags,
      outputFormats: GLOBAL_OUTPUT_FORMATS,
    }),
    withJsonErrorHandling,
  );

export const whoamiCommand = Command.make("whoami", config).pipe(
  Command.withDescription("Show information about the currently logged-in user."),
  Command.withShortDescription("Show the current user"),
  Command.withExamples([
    {
      command: "supabase whoami",
      description: "Show the current user",
    },
    {
      command: "supabase whoami --output-format json",
      description: "Show the current user as JSON",
    },
  ]),
  Command.withHandler(whoamiHandler),
  Command.provide(managementApiRuntimeLayer(["whoami"])),
);
