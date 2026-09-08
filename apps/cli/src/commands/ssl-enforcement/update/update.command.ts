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
import { sslEnforcementUpdate } from "./update.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  enableDbSslEnforcement: Flag.boolean("enable-db-ssl-enforcement").pipe(
    Flag.withDescription(
      "Whether the DB should enable SSL enforcement for all external connections.",
    ),
    Flag.withDefault(false),
  ),
  disableDbSslEnforcement: Flag.boolean("disable-db-ssl-enforcement").pipe(
    Flag.withDescription(
      "Whether the DB should disable SSL enforcement for all external connections.",
    ),
    Flag.withDefault(false),
  ),
} as const;

export type SslEnforcementUpdateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const sslEnforcementUpdateCommand = Command.make("update", config).pipe(
  Command.withDescription("Update SSL enforcement configuration."),
  Command.withShortDescription("Update SSL enforcement configuration"),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // Cobra parses flags — rejecting an out-of-enum `-o` (`internal/utils/enum.go:21-27`)
      // — before `PersistentPreRunE` ever runs (`cobra@v1.10.2/command.go:919,985`), so an
      // invalid `-o` value must win over a missing `--experimental` flag.
      yield* validateOutputFormat(RESOURCE_OUTPUT_FORMATS);
      // Go gates `sslEnforcementCmd` behind `--experimental` in PersistentPreRunE
      // (root.go:91-96) BEFORE the `IsManagementAPI` login check (root.go:105-109).
      // `managementApiRuntimeLayer` eagerly resolves an access token as part
      // of building its `CommandPlatformApi` layer, so it must be provided AFTER
      // the gate (inline here) rather than via `Command.provide` on the whole
      // command — `Command.provide` would build the layer, and fail on a missing
      // token, before this generator's first `yield*` ever runs.
      yield* requireExperimental;
      return yield* sslEnforcementUpdate(flags).pipe(
        withCommandTelemetry({ flags }),
        Effect.provide(managementApiRuntimeLayer(["ssl-enforcement", "update"])),
      );
    }).pipe(withJsonErrorHandling),
  ),
);
