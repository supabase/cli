import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { rejectIncludeRawOutput } from "../domains.removed-flag.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { domainsActivate } from "./activate.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  ...projectTargetFlags(),
  // Kept parsed (and hidden) only so using it produces the removal error instead of an
  // unknown-flag parse error.
  includeRawOutput: cliFlag("include-raw-output", Flag.Boolean, {
    description: "Removed: use -o json instead.",
    optional: true,
    hidden: true,
  }),
} as const;

const COMMAND_PATH = ["domains", "activate"];
const managementApiLayer = managementApiRuntimeLayer(COMMAND_PATH);

export type DomainsActivateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const domainsActivateCommand = makeCommand("activate", config).pipe(
  Command.withDescription(
    "Makes your project respond to requests on its custom hostname. After activation, your project's auth services no longer work on the Supabase-provisioned subdomain.",
  ),
  Command.withShortDescription("Activate the custom hostname for a project"),
  Command.withExamples([
    {
      command: "supabase domains activate --remote=abcdefghijklmnopqrst",
      description: "Activate the custom hostname for a project",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [{ operationId: "v1-activate-custom-hostname", kind: "required" }],
        noApiEffectFlags: ["include-raw-output"],
      },
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    Option.isSome(flags.includeRawOutput)
      ? rejectIncludeRawOutput(COMMAND_PATH, flags)
      : domainsActivate(flags).pipe(
          withCommandTelemetry({ flags }),
          withJsonErrorHandling,
          Effect.provide(managementApiLayer),
        ),
  ),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
