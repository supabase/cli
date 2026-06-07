import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyBranchesDisable } from "./disable.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyBranchesDisableFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyBranchesDisableCommand = Command.make("disable", config).pipe(
  Command.withDescription("Disable preview branching for the linked project."),
  Command.withShortDescription("Disable preview branching"),
  Command.withHandler((flags) =>
    legacyBranchesDisable(flags).pipe(
      withLegacyCommandInstrumentation({ flags, safeFlags: ["project-ref"] }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["branches", "disable"])),
);
