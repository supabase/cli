import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyNetworkRestrictionsGet } from "./get.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyNetworkRestrictionsGetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyNetworkRestrictionsGetCommand = Command.make("get", config).pipe(
  Command.withDescription("Get the current network restrictions."),
  Command.withShortDescription("Get the current network restrictions"),
  Command.withHandler((flags) =>
    legacyNetworkRestrictionsGet(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["network-restrictions", "get"])),
);
