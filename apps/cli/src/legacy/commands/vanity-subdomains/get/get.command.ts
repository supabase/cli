import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyVanitySubdomainsGet } from "./get.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
};

export type LegacyVanitySubdomainsGetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyVanitySubdomainsGetCommand = Command.make("get", config).pipe(
  Command.withDescription("Get the current vanity subdomain."),
  Command.withShortDescription("Get the current vanity subdomain"),
  Command.withHandler((flags) =>
    legacyVanitySubdomainsGet(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["vanity-subdomains", "get"])),
);
