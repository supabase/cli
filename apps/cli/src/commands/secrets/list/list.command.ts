import type * as CliCommand from "effect/cli/Command";
import { Command } from "effect/cli";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { secretsList } from "./list.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  ...projectTargetFlags(),
} as const;

export type SecretsListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const secretsListCommand = makeCommand("list", config).pipe(
  Command.withDescription(
    "Show the names and digests of the secrets set on the linked project. Secret values are never shown.",
  ),
  Command.withShortDescription("List secrets on the linked project"),
  Command.withExamples([
    {
      command: "supabase secrets list",
      description: "List all secrets for the linked project",
    },
    {
      command: "supabase secrets list --remote=abcdefghijklmnopqrst",
      description: "List secrets for a specific project",
    },
  ]),
  withPermissions(
    compose(
      { operations: [{ operationId: "v1-list-all-secrets", kind: "required" }] },
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    secretsList(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["secrets", "list"])),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
