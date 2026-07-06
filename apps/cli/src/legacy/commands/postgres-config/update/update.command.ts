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
import { legacyPostgresConfigUpdate } from "./update.handler.ts";

export const legacyPostgresConfigUpdateConfigFlag = Flag.string("config").pipe(
  Flag.withDescription("Config overrides specified as a 'key=value' pair"),
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
  config: legacyPostgresConfigUpdateConfigFlag,
  replaceExistingOverrides: Flag.boolean("replace-existing-overrides").pipe(
    Flag.withDescription(
      "If true, replaces all existing overrides with the ones provided. If false (default), merges existing overrides with the ones provided.",
    ),
  ),
  noRestart: Flag.boolean("no-restart").pipe(
    Flag.withDescription("Do not restart the database after updating config."),
  ),
} as const;

export type LegacyPostgresConfigUpdateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyPostgresConfigUpdateCommand = Command.make("update", config).pipe(
  Command.withDescription("Update Postgres database config."),
  Command.withShortDescription("Update Postgres database config"),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // Cobra parses flags — rejecting an out-of-enum `-o` (`internal/utils/enum.go:21-27`)
      // — before `PersistentPreRunE` ever runs (`cobra@v1.10.2/command.go:919,985`), so an
      // invalid `-o` value must win over a missing `--experimental` flag.
      yield* legacyValidateOutputFormat(LEGACY_RESOURCE_OUTPUT_FORMATS);
      // Go gates `postgresCmd` behind `--experimental` in PersistentPreRunE
      // (root.go:91-96) BEFORE the `IsManagementAPI` login check (root.go:105-109).
      // `legacyManagementApiRuntimeLayer` eagerly resolves an access token as part
      // of building its `LegacyPlatformApi` layer, so it must be provided AFTER
      // the gate (inline here) rather than via `Command.provide` on the whole
      // command — `Command.provide` would build the layer, and fail on a missing
      // token, before this generator's first `yield*` ever runs.
      yield* legacyRequireExperimental;
      return yield* legacyPostgresConfigUpdate(flags).pipe(
        withLegacyCommandInstrumentation({ flags }),
        Effect.provide(legacyManagementApiRuntimeLayer(["postgres-config", "update"])),
      );
    }).pipe(withJsonErrorHandling),
  ),
);
