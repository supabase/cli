import { Argument, Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyOrgsCreate } from "./create.handler.ts";

const config = {
  name: Argument.string("name").pipe(
    Argument.withDescription("Display name for the new organization."),
  ),
};
export type LegacyOrgsCreateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyOrgsCreateCommand = Command.make("create", config).pipe(
  Command.withDescription("Create an organization for the logged-in user."),
  Command.withShortDescription("Create an organization"),
  Command.withHandler((flags) =>
    legacyOrgsCreate(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["orgs", "create"])),
);
