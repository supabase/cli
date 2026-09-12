import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { requireExperimental } from "../../../command-internal/experimental-gate.ts";
import { RESOURCE_OUTPUT_FORMATS } from "../../../command-internal/go-output-flag.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { stringSliceFlag } from "../../../command-internal/string-slice-flag.ts";
import {
  validateOutputFormat,
  withCommandTelemetry,
} from "../../../telemetry/command-telemetry.ts";
import { networkRestrictionsUpdate } from "./update.handler.ts";

/**
 * CSV-splits each occurrence (`--db-allow-cidr=1.2.3.0/24,5.6.7.0/24` → two CIDRs) and
 * appends across repeats, failing at parse time with pflag's diagnostic on malformed CSV.
 * If `-o` is also invalid, this error wins since `-o` is validated later, in the handler.
 */
export const networkRestrictionsUpdateDbAllowCidrFlag = stringSliceFlag(
  "db-allow-cidr",
  "CIDR to allow DB connections from.",
);

const config = {
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  dbAllowCidr: networkRestrictionsUpdateDbAllowCidrFlag,
  bypassCidrChecks: Flag.Boolean("bypass-cidr-checks").pipe(
    Flag.withDescription("Bypass some of the CIDR validation checks."),
    Flag.withDefault(false),
  ),
  append: Flag.Boolean("append").pipe(
    Flag.withDescription("Append to existing restrictions instead of replacing them."),
    Flag.withDefault(false),
  ),
} as const;

export type NetworkRestrictionsUpdateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const networkRestrictionsUpdateCommand = Command.make("update", config).pipe(
  Command.withDescription("Update network restrictions."),
  Command.withShortDescription("Update network restrictions"),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // Validate the -o value before the --experimental gate, so an invalid value is
      // reported even without --experimental set.
      yield* validateOutputFormat(RESOURCE_OUTPUT_FORMATS);
      // The gate also runs before this command's own CIDR validation. managementApiRuntimeLayer
      // eagerly resolves an access token, so it's provided here (after the gate) rather than
      // via Command.provide, which would fail on a missing token before this generator's
      // first yield* runs.
      yield* requireExperimental;
      return yield* networkRestrictionsUpdate(flags).pipe(
        withCommandTelemetry({ flags }),
        Effect.provide(managementApiRuntimeLayer(["network-restrictions", "update"])),
      );
    }).pipe(withJsonErrorHandling),
  ),
);
