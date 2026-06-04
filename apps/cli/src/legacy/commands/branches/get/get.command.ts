import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyBranchesGet } from "./get.handler.ts";

const config = {
  name: Argument.string("name").pipe(
    Argument.withDescription("Branch name or ID."),
    Argument.optional,
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyBranchesGetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyBranchesGetCommand = Command.make("get", config).pipe(
  Command.withDescription(
    "Retrieve details of the specified preview branch.\n\nNote: For the main branch, password-dependent fields (POSTGRES_URL, POSTGRES_URL_NON_POOLING) are not populated because production database credentials are not retrievable via API.",
  ),
  Command.withShortDescription("Retrieve details of a preview branch"),
  Command.withHandler((flags) =>
    legacyBranchesGet(flags).pipe(
      withLegacyCommandInstrumentation({ flags, safeFlags: ["project-ref"] }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["branches", "get"])),
);
