import { Argument, Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { orgsCreate } from "./create.handler.ts";

const config = {
  name: Argument.String("name").pipe(
    Argument.withDescription("Display name for the new organization."),
  ),
};
export type OrgsCreateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const orgsCreateCommand = Command.make("create", config).pipe(
  Command.withDescription("Create an organization for the logged-in user."),
  Command.withShortDescription("Create an organization"),
  Command.withHandler((flags) =>
    orgsCreate(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["orgs", "create"])),
);
