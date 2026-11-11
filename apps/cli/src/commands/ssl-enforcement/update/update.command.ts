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
import {
  validateOutputFormat,
  withCommandTelemetry,
} from "../../../telemetry/command-telemetry.ts";
import { sslEnforcementUpdate } from "./update.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  ...projectTargetFlags(),
  enableDbSslEnforcement: cliFlag("enable-db-ssl-enforcement", Flag.Boolean, {
    description: "Require SSL for all external database connections.",
    default: false,
  }),
  disableDbSslEnforcement: cliFlag("disable-db-ssl-enforcement", Flag.Boolean, {
    description: "Stop requiring SSL for external database connections.",
    default: false,
  }),
} as const;

export type SslEnforcementUpdateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const sslEnforcementUpdateCommand = makeCommand("update", config).pipe(
  Command.withDescription(
    "Turns SSL enforcement on or off for external database connections. Pass exactly one of `--enable-db-ssl-enforcement` or `--disable-db-ssl-enforcement`.",
  ),
  Command.withShortDescription("Update SSL enforcement configuration"),
  Command.withExamples([
    {
      command:
        "supabase ssl-enforcement update --enable-db-ssl-enforcement --experimental --remote=<project-ref>",
      description: "Require SSL for database connections",
    },
    {
      command:
        "supabase ssl-enforcement update --disable-db-ssl-enforcement --experimental --remote=<project-ref>",
      description: "Stop requiring SSL for database connections",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [
          {
            operationId: "v1-update-ssl-enforcement-config",
            kind: "required",
            when: [{ flag: "enable-db-ssl-enforcement", is: true }],
          },
          {
            operationId: "v1-update-ssl-enforcement-config",
            kind: "required",
            when: [{ flag: "disable-db-ssl-enforcement", is: true }],
          },
        ],
      },
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // An invalid `-o` value must be rejected before the missing
      // `--experimental` check, matching flag-parsing precedence.
      yield* validateOutputFormat(RESOURCE_OUTPUT_FORMATS);
      // The --experimental gate must run before `managementApiRuntimeLayer` is
      // provided (inline here, not via `Command.provide`) — that layer eagerly
      // resolves an access token and would fail on a missing one first.
      yield* requireExperimental;
      return yield* sslEnforcementUpdate(flags).pipe(
        withCommandTelemetry({ flags }),
        Effect.provide(managementApiRuntimeLayer(["ssl-enforcement", "update"])),
      );
    }).pipe(withJsonErrorHandling),
  ),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
