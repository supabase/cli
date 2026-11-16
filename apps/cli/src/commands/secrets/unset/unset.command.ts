import type * as CliCommand from "effect/cli/Command";
import { Argument, Command, Flag } from "effect/cli";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { secretsUnset } from "./unset.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  ...projectTargetFlags(),
  names: Argument.String("NAME").pipe(
    Argument.withDescription("Secret names to unset."),
    Argument.variadic(),
  ),
  all: Flag.Boolean("all").pipe(
    Flag.withDescription(
      "Unset every secret except SUPABASE_ ones. Required when no names are given.",
    ),
    Flag.withDefault(false),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Print the secrets that would be unset without unsetting them."),
    Flag.withDefault(false),
  ),
} as const;

export type SecretsUnsetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const secretsUnsetCommand = Command.make("unset", config).pipe(
  Command.withDescription("Unset a secret(s) from the linked Supabase project."),
  Command.withShortDescription("Unset a secret(s) on Supabase"),
  Command.withExamples([
    {
      command: "supabase secrets unset MY_SECRET",
      description: "Unset a secret by name",
    },
    {
      command: "supabase secrets unset MY_SECRET OTHER_SECRET",
      description: "Unset multiple secrets",
    },
    {
      command: "supabase secrets unset --all",
      description: "Unset every custom secret after confirming",
    },
    {
      command: "supabase secrets unset --all --dry-run",
      description: "Preview which secrets --all would unset",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [
          {
            operationId: "v1-list-all-secrets",
            kind: "required",
            when: [{ flag: "all", is: true }],
          },
          {
            operationId: "v1-bulk-delete-secrets",
            kind: "required",
            when: [{ flag: "dry-run", is: false }],
          },
        ],
      },
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    secretsUnset(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["secrets", "unset"])),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
