import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyVanitySubdomainsDelete } from "./delete.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyVanitySubdomainsDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyVanitySubdomainsDeleteCommand = Command.make("delete", config).pipe(
  Command.withDescription(
    "Deletes the vanity subdomain for a project, and reverts to using the project ref for routing.",
  ),
  Command.withShortDescription("Delete the vanity subdomain"),
  Command.withHandler((flags) =>
    legacyVanitySubdomainsDelete(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["vanity-subdomains", "delete"])),
);
