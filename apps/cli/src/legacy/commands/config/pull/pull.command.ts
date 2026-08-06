import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyConfigPull } from "./pull.handler.ts";

const config = {
  target: Flag.string("target").pipe(
    Flag.withDescription("Remote branch name to compare with local config."),
  ),
} as const;

export type LegacyConfigPullFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyConfigPullCommand = Command.make("pull", config).pipe(
  Command.withDescription(
    "Pull hosted configuration for a remote branch and compare it with the local project config.",
  ),
  Command.withShortDescription("Compare remote branch config with local config"),
  Command.withExamples([
    {
      command: "supabase config pull --target feature/login",
      description: "Show config differences for a remote branch",
    },
  ]),
  Command.withHandler((flags) =>
    legacyConfigPull(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["config", "pull"])),
);
