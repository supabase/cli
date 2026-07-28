import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyRequireExperimental } from "../../../shared/legacy-experimental-gate.ts";
import { LEGACY_RESOURCE_OUTPUT_FORMATS } from "../../../shared/legacy-go-output-flag.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { legacyParseStringSliceFlag } from "../../../shared/legacy-string-slice-flag.ts";
import {
  legacyValidateOutputFormat,
  withLegacyCommandInstrumentation,
} from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyNetworkRestrictionsUpdate } from "./update.handler.ts";

// Go declares `--db-allow-cidr` with pflag's `StringSliceVar` (`cmd/restrictions.go:40`),
// which CSV-splits each occurrence (`--db-allow-cidr=1.2.3.0/24,5.6.7.0/24` → two
// CIDRs) and appends across repeats.
export const legacyNetworkRestrictionsUpdateDbAllowCidrFlag = Flag.string("db-allow-cidr").pipe(
  Flag.withDescription("CIDR to allow DB connections from."),
  Flag.atLeast(0),
  Flag.mapTryCatch(
    (rawValues) => legacyParseStringSliceFlag(rawValues),
    (err) => (err instanceof Error ? err.message : String(err)),
  ),
);

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  dbAllowCidr: legacyNetworkRestrictionsUpdateDbAllowCidrFlag,
  bypassCidrChecks: Flag.boolean("bypass-cidr-checks").pipe(
    Flag.withDescription("Bypass some of the CIDR validation checks."),
  ),
  append: Flag.boolean("append").pipe(
    Flag.withDescription("Append to existing restrictions instead of replacing them."),
  ),
} as const;

export type LegacyNetworkRestrictionsUpdateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyNetworkRestrictionsUpdateCommand = Command.make("update", config).pipe(
  Command.withDescription("Update network restrictions."),
  Command.withShortDescription("Update network restrictions"),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // Cobra parses flags — rejecting an out-of-enum `-o` (`internal/utils/enum.go:21-27`)
      // — before `PersistentPreRunE` ever runs (`cobra@v1.10.2/command.go:919,985`), so an
      // invalid `-o` value must win over a missing `--experimental` flag.
      yield* legacyValidateOutputFormat(LEGACY_RESOURCE_OUTPUT_FORMATS);
      // Go gates `restrictionsCmd` (network-restrictions) behind `--experimental` in
      // PersistentPreRunE (root.go:91-96) BEFORE the `IsManagementAPI` login check
      // (root.go:105-109) — and before RunE, so the gate also precedes this command's
      // local CIDR validation. `legacyManagementApiRuntimeLayer` eagerly resolves an
      // access token as part of building its `LegacyPlatformApi` layer, so it must
      // be provided AFTER the gate (inline here) rather than via `Command.provide`
      // on the whole command — `Command.provide` would build the layer, and fail on
      // a missing token, before this generator's first `yield*` ever runs.
      yield* legacyRequireExperimental;
      return yield* legacyNetworkRestrictionsUpdate(flags).pipe(
        withLegacyCommandInstrumentation({ flags }),
        Effect.provide(legacyManagementApiRuntimeLayer(["network-restrictions", "update"])),
      );
    }).pipe(withJsonErrorHandling),
  ),
);
