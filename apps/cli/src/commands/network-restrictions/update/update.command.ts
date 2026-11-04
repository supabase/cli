import { Effect } from "effect";
import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { requireExperimental } from "../../../command-internal/experimental-gate.ts";
import { RESOURCE_OUTPUT_FORMATS } from "../../../command-internal/output-formats.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { stringSliceFlag } from "../../../command-internal/string-slice-flag.ts";
import {
  validateOutputFormat,
  withCommandTelemetry,
} from "../../../telemetry/command-telemetry.ts";
import { networkRestrictionsUpdate } from "./update.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

/**
 * CSV-splits each occurrence (`--db-allow-cidr=1.2.3.0/24,5.6.7.0/24` → two CIDRs) and
 * appends across repeats, failing at parse time with a diagnostic on malformed CSV.
 * If `-o` is also invalid, this error wins since `-o` is validated later, in the handler.
 */
export const networkRestrictionsUpdateDbAllowCidrFlag = stringSliceFlag(
  "db-allow-cidr",
  "CIDR range allowed to connect to the database, comma-separated or repeated.",
);

const config = {
  ...projectTargetFlags(),
  dbAllowCidr: networkRestrictionsUpdateDbAllowCidrFlag,
  bypassCidrChecks: cliFlag("bypass-cidr-checks", Flag.Boolean, {
    description: "Allow private IP ranges that CIDR validation would otherwise reject.",
    default: false,
  }),
  append: cliFlag("append", Flag.Boolean, {
    description: "Append to existing restrictions instead of replacing them.",
    default: false,
  }),
} as const;

export type NetworkRestrictionsUpdateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const networkRestrictionsUpdateCommand = makeCommand("update", config).pipe(
  Command.withDescription("Sets the CIDR ranges allowed to connect to your project's database. By default the ranges you pass replace the existing ones; use `--append` to add to them."),
  Command.withShortDescription("Update network restrictions"),
  Command.withExamples([
    {
      command: "supabase network-restrictions update --db-allow-cidr 203.0.113.0/24 --experimental --remote=<project-ref>",
      description: "Replace the allowed CIDR ranges",
    },
    {
      command: "supabase network-restrictions update --db-allow-cidr 198.51.100.0/24 --append --experimental --remote=<project-ref>",
      description: "Add a CIDR range to the existing ones",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [
          {
            operationId: "v1-update-network-restrictions",
            kind: "required",
            when: [{ flag: "append", is: false }],
          },
          {
            operationId: "v1-patch-network-restrictions",
            kind: "required",
            when: [{ flag: "append", is: true }],
          },
        ],
        noApiEffectFlags: ["db-allow-cidr", "bypass-cidr-checks"],
      },
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
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
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
