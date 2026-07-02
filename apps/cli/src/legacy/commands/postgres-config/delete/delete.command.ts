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
import { legacyPostgresConfigDelete } from "./delete.handler.ts";

export const legacyPostgresConfigDeleteConfigFlag = Flag.string("config").pipe(
  Flag.withDescription("Config keys to delete (comma-separated)"),
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
  config: legacyPostgresConfigDeleteConfigFlag,
  noRestart: Flag.boolean("no-restart").pipe(
    Flag.withDescription("Do not restart the database after deleting config."),
  ),
} as const;

export type LegacyPostgresConfigDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyPostgresConfigDeleteCommand = Command.make("delete", config).pipe(
  Command.withDescription("Delete specific Postgres database config overrides."),
  Command.withShortDescription("Delete Postgres database config overrides"),
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
      return yield* legacyPostgresConfigDelete(flags).pipe(
        withLegacyCommandInstrumentation({ flags }),
        Effect.provide(legacyManagementApiRuntimeLayer(["postgres-config", "delete"])),
      );
    }).pipe(withJsonErrorHandling),
  ),
);
