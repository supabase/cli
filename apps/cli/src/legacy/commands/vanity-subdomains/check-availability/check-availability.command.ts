import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyVanitySubdomainsCheckAvailability } from "./check-availability.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  desiredSubdomain: Flag.string("desired-subdomain").pipe(
    Flag.withDescription("The desired vanity subdomain to use for your Supabase project."),
  ),
} as const;

export type LegacyVanitySubdomainsCheckAvailabilityFlags = CliCommand.Command.Config.Infer<
  typeof config
>;

export const legacyVanitySubdomainsCheckAvailabilityCommand = Command.make(
  "check-availability",
  config,
).pipe(
  Command.withDescription("Checks if a desired subdomain is available for use."),
  Command.withShortDescription("Check subdomain availability"),
  Command.withHandler((flags) =>
    legacyVanitySubdomainsCheckAvailability(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["vanity-subdomains", "check-availability"])),
);
