import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacySslEnforcementGet } from "./get.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacySslEnforcementGetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacySslEnforcementGetCommand = Command.make("get", config).pipe(
  Command.withDescription("Get the current SSL enforcement configuration."),
  Command.withShortDescription("Get SSL enforcement configuration"),
  Command.withHandler((flags) =>
    legacySslEnforcementGet(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["ssl-enforcement", "get"])),
);
