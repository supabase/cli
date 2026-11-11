import { Argument, Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { orgsCreate } from "./create.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliArgument, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  name: cliArgument("name", Argument.String, {
    description: "Display name of the new organization.",
    required: true,
  }),
};
export type OrgsCreateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const orgsCreateCommand = makeCommand("create", config).pipe(
  Command.withDescription(
    "Create a new organization under your account, which you can then create projects in.",
  ),
  Command.withShortDescription("Create an organization"),
  Command.withExamples([
    {
      command: 'supabase orgs create "My Organization"',
      description: "Create an organization",
    },
  ]),
  withPermissions({ operations: [{ operationId: "v1-create-an-organization", kind: "required" }] }),
  Command.withHandler((flags) =>
    orgsCreate(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["orgs", "create"])),
  withTargetPolicy({ group: "account", consent: "yes" }),
);
