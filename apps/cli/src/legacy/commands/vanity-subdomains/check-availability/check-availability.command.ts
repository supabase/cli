import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyRequireExperimental } from "../../../shared/legacy-experimental-gate.ts";
import { LEGACY_RESOURCE_OUTPUT_FORMATS } from "../../../shared/legacy-go-output-flag.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import {
  legacyValidateOutputFormat,
  withLegacyCommandInstrumentation,
} from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyVanitySubdomainsCheckAvailability } from "./check-availability.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  // Go marks this flag required (`cmd/vanitySubdomains.go:69`), but cobra
  // validates required flags only AFTER `PersistentPreRunE`
  // (`cobra@v1.10.2/command.go:985,1005`) — so the `--experimental` gate,
  // login check, and project-ref resolution must all win over a missing
  // `--desired-subdomain`. Optional at parse time; presence is enforced in
  // the handler (after ref resolution) instead.
  desiredSubdomain: Flag.string("desired-subdomain").pipe(
    Flag.withDescription("The desired vanity subdomain to use for your Supabase project."),
    Flag.optional,
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
    Effect.gen(function* () {
      // Cobra parses flags — rejecting an out-of-enum `-o` (`internal/utils/enum.go:21-27`)
      // — before `PersistentPreRunE` ever runs (`cobra@v1.10.2/command.go:919,985`), so an
      // invalid `-o` value must win over a missing `--experimental` flag.
      yield* legacyValidateOutputFormat(LEGACY_RESOURCE_OUTPUT_FORMATS);
      // Go gates `vanityCmd` (vanity-subdomains) behind `--experimental` in PersistentPreRunE
      // (root.go:91-96) BEFORE the `IsManagementAPI` login check (root.go:105-109).
      // `legacyManagementApiRuntimeLayer` eagerly resolves an access token as part
      // of building its `LegacyPlatformApi` layer, so it must be provided AFTER
      // the gate (inline here) rather than via `Command.provide` on the whole
      // command — `Command.provide` would build the layer, and fail on a missing
      // token, before this generator's first `yield*` ever runs.
      yield* legacyRequireExperimental;
      return yield* legacyVanitySubdomainsCheckAvailability(flags).pipe(
        withLegacyCommandInstrumentation({ flags }),
        Effect.provide(
          legacyManagementApiRuntimeLayer(["vanity-subdomains", "check-availability"]),
        ),
      );
    }).pipe(withJsonErrorHandling),
  ),
);
