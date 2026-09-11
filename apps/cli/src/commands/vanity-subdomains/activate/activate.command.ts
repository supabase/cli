import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { requireExperimental } from "../../../command-internal/experimental-gate.ts";
import { RESOURCE_OUTPUT_FORMATS } from "../../../command-internal/go-output-flag.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import {
  validateOutputFormat,
  withCommandTelemetry,
} from "../../../telemetry/command-telemetry.ts";
import { vanitySubdomainsActivate } from "./activate.handler.ts";

const config = {
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  // Optional at parse time so the --experimental gate, login check, and project-ref
  // resolution all run first; required-ness is enforced in the handler after ref
  // resolution.
  desiredSubdomain: Flag.String("desired-subdomain").pipe(
    Flag.withDescription("The desired vanity subdomain to use for your Supabase project."),
    Flag.optional,
  ),
} as const;

export type VanitySubdomainsActivateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const vanitySubdomainsActivateCommand = Command.make("activate", config).pipe(
  Command.withDescription(
    "Activate a vanity subdomain for your Supabase project. This reconfigures your Supabase project to respond to requests on your vanity subdomain. After the vanity subdomain is activated, your project's auth services will no longer function on the {project-ref}.{supabase-domain} hostname.",
  ),
  Command.withShortDescription("Activate a vanity subdomain"),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // An invalid `-o` value must win over a missing `--experimental` flag, so this
      // validation runs before the gate.
      yield* validateOutputFormat(RESOURCE_OUTPUT_FORMATS);
      // `managementApiRuntimeLayer` eagerly resolves an access token, so it's provided
      // inline after the experimental gate rather than via `Command.provide` on the
      // whole command — `Command.provide` would build the layer, and fail on a missing
      // token, before the gate ever runs.
      yield* requireExperimental;
      return yield* vanitySubdomainsActivate(flags).pipe(
        withCommandTelemetry({ flags }),
        Effect.provide(managementApiRuntimeLayer(["vanity-subdomains", "activate"])),
      );
    }).pipe(withJsonErrorHandling),
  ),
);
