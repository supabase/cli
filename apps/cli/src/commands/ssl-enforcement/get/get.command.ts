import { Effect } from "effect";
import { Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withDocs } from "../../../docs/command-docs.ts";
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
import { sslEnforcementGet } from "./get.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  ...projectTargetFlags(),
} as const;

export type SslEnforcementGetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const sslEnforcementGetCommand = makeCommand("get", config).pipe(
  Command.withDescription(
    "Shows whether SSL enforcement is enabled for external database connections.",
  ),
  Command.withShortDescription("Get SSL enforcement configuration"),
  Command.withExamples([
    {
      command: "supabase ssl-enforcement get --experimental --remote=<project-ref>",
      description: "Show the SSL enforcement setting of a project",
    },
  ]),
  withDocs({ category: "ssl-enforcement", experimental: true }),
  withPermissions(
    compose(
      {
        operations: [{ operationId: "v1-get-ssl-enforcement-config", kind: "required" }],
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
      return yield* sslEnforcementGet(flags).pipe(
        withCommandTelemetry({ flags }),
        Effect.provide(managementApiRuntimeLayer(["ssl-enforcement", "get"])),
      );
    }).pipe(withJsonErrorHandling),
  ),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
