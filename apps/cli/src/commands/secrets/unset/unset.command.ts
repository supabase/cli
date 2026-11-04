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
import { cliArgument, cliFlag, makeCommand, repeated } from "../../../shared/cli/cli-params.ts";

const config = {
  ...projectTargetFlags(),
  names: cliArgument("NAME", repeated(Argument.String), { description: "Names of the secrets to unset." }),
  all: cliFlag("all", Flag.Boolean, {
    description: "Unset every secret except those prefixed with SUPABASE_; required when no names are given.",
    default: false,
  }),
  dryRun: cliFlag("dry-run", Flag.Boolean, {
    description: "Print the secrets that would be unset without unsetting them.",
    default: false,
  }),
} as const;

export type SecretsUnsetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const secretsUnsetCommand = makeCommand("unset", config).pipe(
  Command.withDescription(
    "Remove one or more secrets from the linked project by name, or every custom secret with `--all`. Use `--dry-run` to preview what would be removed.\n\nAsks for confirmation before changing anything; pass `--yes` in scripts and CI.",
  ),
  Command.withShortDescription("Unset secrets on the linked project"),
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
