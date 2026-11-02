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
import { domainsDelete } from "./delete.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";

const config = {
  ...projectTargetFlags(),
  // Kept parsed (and hidden) only so using it produces the removal error instead of an
  // unknown-flag parse error.
  includeRawOutput: Flag.Boolean("include-raw-output").pipe(
    Flag.withDescription("Removed: use -o json instead."),
    Flag.optional,
    Flag.withHidden,
  ),
} as const;

const COMMAND_PATH = ["domains", "delete"];
const managementApiLayer = managementApiRuntimeLayer(COMMAND_PATH);

export type DomainsDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

export const domainsDeleteCommand = Command.make("delete", config).pipe(
  Command.withDescription("Deletes the custom hostname config for your project."),
  Command.withShortDescription("Delete the custom hostname config"),
  Command.withExamples([
    {
      command: "supabase domains delete --remote=abcdefghijklmnopqrst",
      description: "Delete the custom hostname config for a project",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [{ operationId: "v1-Delete hostname config", kind: "required" }],
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
      : domainsDelete(flags).pipe(
          withCommandTelemetry({ flags }),
          withJsonErrorHandling,
          Effect.provide(managementApiLayer),
        ),
  ),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
