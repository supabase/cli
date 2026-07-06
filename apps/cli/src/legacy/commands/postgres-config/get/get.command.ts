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
import { legacyPostgresConfigGet } from "./get.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyPostgresConfigGetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyPostgresConfigGetCommand = Command.make("get", config).pipe(
  Command.withDescription("Get the current Postgres database config overrides."),
  Command.withShortDescription("Get Postgres database config"),
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
      return yield* legacyPostgresConfigGet(flags).pipe(
        withLegacyCommandInstrumentation({ flags }),
        Effect.provide(legacyManagementApiRuntimeLayer(["postgres-config", "get"])),
      );
    }).pipe(withJsonErrorHandling),
  ),
);
